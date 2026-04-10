# Task Breakdown: Marketplace 03 Extension (Dork Hub Browse UI)

Generated: 2026-04-06
Source: specs/marketplace-03-extension/02-specification.md
Mode: Full

## Overview

This breakdown decomposes the Dork Hub spec into 30 implementation tasks across 10 phases. Dork Hub is the in-app marketplace browse experience, shipped as a built-in DorkOS extension (`@dorkos-builtin/marketplace`). It consumes the HTTP API from spec 02 (marketplace-02-install), registers a `sidebar.tabs` slot, and surfaces browse / search / install / manage UI.

The critical path runs: foundation (extension scaffolding + ensure helper) → transport + hooks → browse UI → detail + install flow → widget wiring. Sources management, installed management, TemplatePicker integration, playground, and tests fan out in parallel wherever possible.

## Phase 1: Foundation (4 tasks)

Server-side scaffolding: built-in extension manifest, `ensureBuiltinMarketplaceExtension` helper mirroring `ensureDorkBot`, tests, and startup wiring.

### Task 1.1: Scaffold built-in marketplace extension directory and manifest

**Size**: Small | **Priority**: High | **Deps**: none | **Parallel**: —

Create `apps/server/src/builtin-extensions/marketplace/` with `extension.json`, `index.ts` (client entry), and `server.ts` (server entry). Manifest declares `sidebar.tabs` slot pointing at `/marketplace`.

### Task 1.2: Create ensureBuiltinMarketplaceExtension helper

**Size**: Medium | **Priority**: High | **Deps**: 1.1

Create `apps/server/src/services/builtin-extensions/ensure-marketplace.ts` mirroring `ensureDorkBot` — three paths: fresh install, version upgrade, no-op. Uses `parseExtensionManifest` from `@dorkos/extension-api/manifest-schema`.

### Task 1.3: Unit tests for ensureBuiltinMarketplaceExtension

**Size**: Medium | **Priority**: High | **Deps**: 1.2

Vitest coverage for all 3 paths + invalid manifest. Mocks `fs/promises`, the `ExtensionManager`, and `logger`.

### Task 1.4: Wire ensureBuiltinMarketplaceExtension into server startup

**Size**: Small | **Priority**: High | **Deps**: 1.2 | **Parallel**: 1.3

Modify `apps/server/src/index.ts` to call the helper after `ExtensionManager` is ready, before HTTP listener starts.

## Phase 2: Transport & Hooks (4 tasks)

### Task 2.1: Add marketplace transport methods

**Size**: Small | **Priority**: High | **Deps**: none

`apps/client/src/layers/shared/lib/transport/marketplace-methods.ts` with 10 typed methods wrapping `/api/marketplace/*`. Exported from transport barrel.

### Task 2.2: Implement marketplace entity query hooks

**Size**: Medium | **Priority**: High | **Deps**: 2.1

5 TanStack Query hooks: `useMarketplacePackages`, `useMarketplacePackage`, `usePermissionPreview`, `useInstalledPackages`, `useMarketplaceSources`.

### Task 2.3: Implement marketplace entity mutation hooks

**Size**: Medium | **Priority**: High | **Deps**: 2.1 | **Parallel**: 2.2

5 mutation hooks: `useInstallPackage`, `useUninstallPackage`, `useUpdatePackage`, `useAddMarketplaceSource`, `useRemoveMarketplaceSource`. Each invalidates relevant query keys on success.

### Task 2.4: Test marketplace hooks with mock transport

**Size**: Medium | **Priority**: Medium | **Deps**: 2.2, 2.3

React Testing Library + `renderHook` + mocked `marketplaceMethods`. Covers success, error, and mutation invalidation.

## Phase 3: Browse UI Core (7 tasks)

### Task 3.1: Create dorkHub Zustand store

**Size**: Small | **Priority**: High | **Deps**: 2.2

`features/marketplace/model/dork-hub-store.ts` with filters (type, category, search, sort), detail package, install confirm package.

### Task 3.2: Implement package-filter, package-sort, format-permissions libs

**Size**: Medium | **Priority**: High | **Deps**: 3.1

3 pure utility modules + 2 unit test files. No React imports.

### Task 3.3: Build PackageTypeBadge and PackageCard

**Size**: Medium | **Priority**: High | **Deps**: 3.1 | **Parallel**: 3.2

Visual building blocks for the grid. Follow Calm Tech: `rounded-xl`, `p-6`, `cn()`. Install button uses `stopPropagation`.

### Task 3.4: Build PackageGrid with loading/empty/error states

**Size**: Large | **Priority**: High | **Deps**: 3.1, 3.2, 3.3

Main browse grid using `useMarketplacePackages` + filter/sort utilities. Responsive 1/2/3/4-column grid with distinct loading, error, and empty states.

### Task 3.5: Build DorkHubHeader with search and type tabs

**Size**: Medium | **Priority**: High | **Deps**: 3.1 | **Parallel**: 3.2, 3.3, 3.4

Debounced search (300ms) + 5 type filter tabs. Accessible labels + ARIA tablist.

### Task 3.6: Build FeaturedAgentsRail

**Size**: Small | **Priority**: High | **Deps**: 3.3 | **Parallel**: 3.4, 3.5

Horizontal rail of featured agents. Renders nothing when zero featured.

### Task 3.7: Compose DorkHub root component

**Size**: Small | **Priority**: High | **Deps**: 3.4, 3.5, 3.6, 4.1, 4.3

Top-level feature component composing header, rail, grid, detail sheet, install confirmation dialog. Exports barrel.

## Phase 4: Detail & Install Flow (4 tasks)

### Task 4.1: Build PermissionPreviewSection

**Size**: Medium | **Priority**: High | **Deps**: 3.2

Permission preview display with 5 grouped sections (effects, secrets, hosts, dependencies, conflicts). Collapses empty sections. Conflicts use warning tone.

### Task 4.2: Build PackageDetailSheet slide-over

**Size**: Large | **Priority**: High | **Deps**: 3.1, 4.1

Slide-in sheet using shadcn `Sheet`. Fetches detail + preview, renders README via `streamdown`, shows install/uninstall action based on state.

### Task 4.3: Build InstallConfirmationDialog

**Size**: Large | **Priority**: High | **Deps**: 3.1, 4.1 | **Parallel**: 4.2

Blocking modal showing permission preview. Install button disabled on error-level conflicts or while preview loads.

### Task 4.4: Build InstallProgressToast and use-install-with-toast hook

**Size**: Medium | **Priority**: Medium | **Deps**: 4.3

Wrapper hook around `useInstallPackage` with pending/success/error toasts. Success toast offers "Configure secrets" action.

## Phase 5: Installed & Sources Management (2 tasks)

### Task 5.1: Build InstalledPackagesView

**Size**: Medium | **Priority**: Medium | **Deps**: 3.3, 3.4

"Manage Installed" surface with update buttons (when `updateAvailable`) and two-click uninstall confirmation (`purge: true`).

### Task 5.2: Build MarketplaceSourcesView

**Size**: Medium | **Priority**: Medium | **Deps**: 2.3 | **Parallel**: 5.1

Sources list + add dialog + remove. Shows package count and last-refreshed timestamp per source.

## Phase 6: Widget & Routing (2 tasks)

### Task 6.1: Create DorkHubPage widget and wire /marketplace route

**Size**: Medium | **Priority**: High | **Deps**: 3.7, 5.2

Widget shells for `DorkHubPage` and `MarketplaceSourcesPage`, route registration in `router.tsx` for `/marketplace` and `/marketplace/sources`.

### Task 6.2: Add Dork Hub entry to DashboardSidebar navigation

**Size**: Small | **Priority**: High | **Deps**: 6.1

Update shared sidebar with Dork Hub nav item (or verify dynamic slot-based registration renders it). Active-state highlighting on both `/marketplace` routes.

## Phase 7: TemplatePicker Integration (1 task)

### Task 7.1: Add From Dork Hub tab to TemplatePicker

**Size**: Medium | **Priority**: High | **Deps**: 2.2 | **Parallel**: 3.1–3.6

Additive refactor of `apps/client/src/layers/features/agent-creation/ui/TemplatePicker.tsx`. Wraps existing content in shadcn `Tabs` with "Built-in", "From Dork Hub", "Custom URL" triggers. Preserves all existing test IDs (`template-grid`, `template-card-<id>`, `custom-url-input`). Marketplace tab uses `agent.source` as the selection value so existing `template-downloader.ts` handles it natively. Marketplace API failure must NOT break the built-in tab.

## Phase 8: Dev Playground (1 task)

### Task 8.1: Add MarketplaceShowcases to dev playground

**Size**: Medium | **Priority**: Medium | **Deps**: 3.4–3.6, 4.1–4.3, 5.1–5.2

12+ showcase sections covering all marketplace components with mock data helper (`marketplace-mocks.ts`). Registered in playground route registry.

## Phase 9: Tests (4 tasks)

### Task 9.1: Unit tests for PackageCard, PackageGrid, DorkHubHeader

**Size**: Large | **Priority**: High | **Deps**: 3.3, 3.4, 3.5

3 RTL test files with 4+ assertions each. Covers loading/error/empty states, click handlers, stopPropagation, debounced search (with fake timers).

### Task 9.2: Unit tests for PackageDetailSheet and InstallConfirmationDialog

**Size**: Large | **Priority**: High | **Deps**: 4.2, 4.3, 4.4 | **Parallel**: 9.1

Mock entity hooks via `vi.mock('@/layers/entities/marketplace')`. Verifies install button disabled on conflicts + during pending, toast mocks fire correctly.

### Task 9.3: Regression tests for TemplatePicker with Dork Hub tab

**Size**: Medium | **Priority**: High | **Deps**: 7.1 | **Parallel**: 9.1, 9.2

Verifies: built-in tab unchanged, From Dork Hub tab shows agents, built-in tab still works when marketplace API errors, no test ID churn.

### Task 9.4: Integration test for browse to install flow

**Size**: Large | **Priority**: Medium | **Deps**: 3.7, 4.2, 4.3, 4.4

End-to-end flow: render `<DorkHub />` → grid loads → click card → detail opens → click install → dialog opens → confirm → assert mutation called. Mocks transport layer.

**Important** (from AGENTS.md): This test mocks at the HTTP method layer and never touches `services/marketplace/transaction.ts`, so it does NOT need the `_internal.isGitRepo` mock. However, the test file header must document this rule for future maintainers who may refactor toward real transport tests. Any future test that exercises server-side flows with `rollbackBranch: true` MUST mock `_internal.isGitRepo` in `beforeEach` to return false, or the rollback will `git reset --hard` against `process.cwd()` and destroy uncommitted work.

## Phase 10: Documentation (2 tasks)

### Task 10.1: Update AGENTS.md and contributing/marketplace-installs.md

**Size**: Medium | **Priority**: High | **Deps**: 1.2, 1.4, 3.7, 6.1

Adds `/marketplace` and `/marketplace/sources` to the routes section of AGENTS.md, mentions `services/builtin-extensions/` in the server architecture paragraph, and appends a new "Dork Hub UI (Built-in Extension)" section to `contributing/marketplace-installs.md` documenting FSD layout, Zustand store, TanStack Query cache keys, and restating the `_internal.isGitRepo` mock rule.

### Task 10.2: Add CHANGELOG entry for Dork Hub

**Size**: Small | **Priority**: Medium | **Deps**: 3.7 | **Parallel**: 10.1

Unreleased entry listing Dork Hub highlights: featured rail, filter/search, detail sheet with README + permission preview, install confirmation, installed management, sources management, TemplatePicker integration.

## Parallel Opportunities

- **Phase 2**: tasks 2.2 and 2.3 run in parallel after 2.1
- **Phase 3**: 3.2 / 3.3 / 3.5 / 3.6 all runnable in parallel once 3.1 lands; 3.4 waits for 3.2 and 3.3
- **Phase 4**: 4.2 and 4.3 run in parallel after 4.1
- **Phase 5**: 5.1 and 5.2 fully independent
- **Phase 7** (TemplatePicker): can start immediately after 2.2 — runs fully in parallel with the entire Phase 3 browse UI work
- **Phase 9**: 9.1, 9.2, 9.3 all independent; 9.4 waits for Phase 4 completion
- **Phase 10**: 10.1 and 10.2 run in parallel

## Critical Path

1.1 → 1.2 → 1.4 (foundation unlocks server-side)
2.1 → 2.2 → 3.1 → 3.2/3.3/3.4 → 4.1 → 4.2/4.3 → 3.7 → 6.1 → 6.2

Everything else (5.x, 7.x, 8.x, 9.x, 10.x) branches off this spine. Total: 30 tasks, longest chain is ~11 hops.
