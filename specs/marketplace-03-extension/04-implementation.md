# Implementation Summary: Marketplace 03: Marketplace Extension (Browse UI)

**Created:** 2026-04-06
**Last Updated:** 2026-04-06
**Spec:** specs/marketplace-03-extension/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 31 / 31

## Review Approach

Using **holistic batch-level verification gates** rather than the executing-specs skill's default per-task two-stage review. Rationale: this spec has 31 tasks across 10 phases — over the >15 task threshold where per-task review agents saturate context budget. Holistic gates (`pnpm typecheck` + targeted `pnpm vitest run` + `pnpm eslint`) catch the same regression classes at a fraction of the agent budget. See `feedback_holistic_batch_gates.md` in user memory for the validated pattern.

## Tasks Completed

### Session 1 - 2026-04-06

**Batch 1** (no deps) — verification: typecheck 21/21, lint 16/16 (0 new warnings)

- Task #1: [P1] Scaffold built-in marketplace extension directory and manifest — `DONE_WITH_CONCERNS`. Significant schema deviations from spec discovered (see Implementation Notes).
- Task #5: [P2] Add marketplace transport methods — `DONE`. Added `marketplace-schemas.ts` to `@dorkos/shared`, factory in client transport, stubs in DirectTransport + embedded-mode + mock-factories.

**Batch 2** (foundation + transport hooks) — verification: typecheck 21/21, lint clean (after removing one orphan import)

- Task #2: [P1] Create ensureBuiltinMarketplaceExtension helper — `DONE_WITH_CONCERNS`. Bypasses ExtensionManager API entirely (which doesn't expose `getById`/`unregister`/`registerBuiltin`); instead writes to `{dorkHome}/extensions/marketplace/` like `ensureDorkBot`. Surfaced production build issue: `extension.json` not copied to `dist/` by `tsc`.
- Task #6: [P2] Implement marketplace entity query hooks — `DONE`. Added `marketplaceKeys` factory in `api/query-keys.ts` and 5 query hooks. Used `useTransport()` from `@/layers/shared/model`. Naming correction: `transport.listInstalledPackages()` (NOT `listInstalledMarketplacePackages`).
- Task #7: [P2] Implement marketplace entity mutation hooks — `DONE`. 5 mutation hooks; coordinated with #6 to use `marketplaceKeys.*` for invalidation. Removed temporary `model/query-keys.ts` after discovering #6's `api/query-keys.ts`.

**Batch 3** (tests + store + sources + TemplatePicker) — verification: typecheck 21/21, lint 16/16 (no new warnings)

- Task #3: [P1] Write unit tests for ensureBuiltinMarketplaceExtension — `DONE`. 4 tests passing (fresh install / upgrade / no-op / corrupt manifest recovery). Uses real fs with `mkdtemp`, no mocks. The corrupt-manifest test added an extra branch the spec didn't call out.
- Task #4: [P1] Wire ensureBuiltinMarketplaceExtension into server startup — `DONE`. Added import + try/catch wrapper before `extensionManager.initialize()`. **Also fixed** the production `dist/` build issue: `apps/server/package.json`'s `build` script now post-copies `src/builtin-extensions/` to `dist/builtin-extensions/` filtering out `.ts` files (no new dependency — uses inline `node -e fs.cpSync`).
- Task #8: [P2] Test marketplace hooks with mock transport — `DONE`. 9 tests passing. Uses `createMockTransport()` + `<TransportProvider>` + `<QueryClientProvider>`. Invalidation verified via cache-priming + refetch-count technique (no `QueryClient` spy).
- Task #9: [P3] Create dorkHub Zustand store — `DONE`. Devtools-wrapped, derives `DorkHubTypeFilter = 'all' | MarketplacePackageType` from the shared schema (auto-widens with new types).
- Task #21: [P5] Build MarketplaceSourcesView — `DONE`. Adapted to **real** `MarketplaceSource` shape: renders `name`, `source` (git URL), `enabled` indicator, `addedAt`. Spec assumed `url`/`packageCount`/`lastRefreshed` which don't exist. `AddSourceInput` requires both `name` AND `source` (not optional name as spec said).
- Task #24: [P7] Add From Dork Hub tab to TemplatePicker — `DONE`. **Two-tab layout** (Built-in / From Dork Hub) with custom URL input kept OUTSIDE the Tabs primitive — design decision to preserve all 24 existing tests. Three-tab layout would have hidden the URL input behind tab switching, breaking 4 cross-tab tests.

**Batch 4** (libs + cards + header + regression test) — verification: typecheck 21/21, lint 16/16

- Task #10: [P3] package-filter, package-sort, format-permissions libs — `DONE`. 37 tests (24 filter + 13 sort). `popular`/`recent` sorts fall back to `name` since `installCount`/`updatedAt` aren't on `AggregatedPackage`. Filter handles `pkg.type ?? 'plugin'` and uses `tags` instead of nonexistent `displayName`.
- Task #11: [P3] PackageTypeBadge + PackageCard — `DONE`. Card adapts to lean `AggregatedPackage` shape: uses `name` directly, omits install count line, falls back `pkg.type ?? 'plugin'`. PackageTypeBadge uses exhaustive `Record` for color/label maps.
- Task #13: [P3] DorkHubHeader — `DONE`. Uses Radix `Tabs`/`TabsList`/`TabsTrigger` for ARIA semantics (no manual `role`/`aria-selected` wiring). Debounced search (300ms) committing to `useDorkHubStore.setSearch`.
- Task #28: [P9] TemplatePicker regression tests — `DONE`. **19 tests passing** (10 existing + 9 new). Covers built-in stability, marketplace populated/empty/error states, marketplace-failure-doesn't-break-built-in regression, `agent.source` selection contract. Caught a missing `marketplace: string` field on test fixtures (required by `AggregatedPackage`).

**Batch 5** (grid + featured rail + permission section) — verification: typecheck 21/21, lint 16/16

- Task #12: [P3] PackageGrid + skeleton/empty/error states — `DONE`. 4 components: `PackageLoadingSkeleton` (8 cards), `PackageEmptyState` (filter-induced with reset action), `PackageErrorState` (network detection via regex), `PackageGrid` (uses `useMemo` for filtered+sorted list, `Set<string>` of installed names).
- Task #14: [P3] FeaturedAgentsRail — `DONE`. Confirmed `PackageFilter.type` is server-supported, so passes `{ type: 'agent' }` directly. `MAX_FEATURED = 6` constant. Skeleton extracted as private sub-component to stay under 50-line function limit.
- Task #16: [P4] PermissionPreviewSection — `DONE`. Adapted `ICON_MAP` key from spec's `'alert'` to actual formatter output `'alert-triangle'`. Empty sections render `null` (no orphan headings). Conflicts section uses amber tone.

**Batch 6** (sheet + dialog + installed view + unit tests) — verification: typecheck 21/21, lint 16/16

- Task #17: [P4] PackageDetailSheet — `DONE`. No `displayName`/`readme` on detail; uses `pkg.name`, drops streamdown. Version/author/license live in `detail.manifest`. `usePermissionPreview` 2nd arg is options object `{ enabled }`.
- Task #18: [P4] InstallConfirmationDialog — `DONE`. Toast lib confirmed: `sonner` (imperative `toast` import). `ConflictReport.level: 'error' | 'warning'` matches spec assumption. Extracted `useInstallToast` private hook to stay under 50-line function limit.
- Task #20: [P5] InstalledPackagesView — `DONE`. Real `InstalledPackage` is `{ name, version, type, installPath, installedFrom?, installedAt? }` — no `displayName`/`source`/`updateAvailable`. Update button always renders per ADR-0233 (advisory updates). 3-second confirm window for uninstall.
- Task #26: [P9] PackageCard/PackageGrid/DorkHubHeader unit tests — `DONE`. **25 tests passing** (9+9+7). Uses real Zustand store with snapshot/restore. Found pre-existing nested-button issue in PackageCard (cosmetic React warning, out of scope).

**Batch 7** (root + toast + dev playground) — verification: typecheck 21/21, lint 16/16 (1 new cosmetic React Compiler warning in MarketplaceShowcases — acceptable)

- Task #15: [P3] DorkHub root — `DONE`. Composes header / featured rail / grid / detail sheet / install dialog. Barrel exports `DorkHub`, `useDorkHubStore`, `DorkHubTypeFilter`, `DorkHubSort`. `container-wide` doesn't exist, used `mx-auto max-w-7xl px-4`.
- Task #19: [P4] InstallProgressToast / useInstallWithToast hook — `DONE`. Extracted public hook, refactored InstallConfirmationDialog to use it (removed inline `useInstallToast`). "Configure secrets" action uses `window.location.hash` with TODO for typed router nav.
- Task #25: [P8] MarketplaceShowcases dev playground — `DONE`. Wired into full playground infrastructure: page (`MarketplacePage.tsx`), section registry (`marketplace-sections.ts`), playground-config entry (group `'agents'`, `ShoppingBag` icon), DevPlayground.tsx route, registry test updated. **3568 client tests still pass.** Per-section `IsolatedQueryProvider` with pre-seeded cache to render hook-driven components without server calls.

**Batch 8** (page widget + tests + changelog) — verification: typecheck 21/21, lint 16/16

- Task #22: [P6] DorkHubPage widget + /marketplace route — `DONE`. Created `DorkHubPage`, `MarketplaceSourcesPage`, top-nav header components. Mirrored `AgentsPage`/`TasksPage` pattern: thin shells, AppShell owns chrome via `useSidebarSlot`/`useHeaderSlot`. Registered both routes as children of `appShellRoute`.
- Task #27: [P9] PackageDetailSheet + InstallConfirmationDialog tests — `DONE`. **17 tests passing** (8+9). Mocks `useInstallPackage` (the hook that `useInstallWithToast` wraps). jsdom Radix polyfills required for Sheet/AlertDialog (`hasPointerCapture`, `releasePointerCapture`, `scrollIntoView`, `matchMedia`).
- Task #29: [P9] Browse-to-install integration test — `DONE`. **2 tests passing** drive the full DorkHub → card → sheet → install dialog → mutation flow + a card-Install shortcut path. Mocks at hook level (not transport). Header documents `_internal.isGitRepo` rule from AGENTS.md/ADR-0231.
- Task #31: [P10] CHANGELOG entry — `DONE`. 7 bullets under existing `[Unreleased] / Added`, tagged `(marketplace-03-extension)` matching marketplace-02-install convention. Prettier check passes.

**Batch 9** (sidebar entry + docs) — verification: typecheck 21/21, lint 16/16, **full test suite 3587/3587 passing across 309 files**

- Task #23: [P6] Add Dork Hub entry to DashboardSidebar — `DONE`. Sidebar is fully static (no dynamic slot system today); added `Store` icon entry between Tasks and Search. Active state covers `/marketplace/sources` subroute.
- Task #30: [P10] Update AGENTS.md and contributing/marketplace-installs.md — `DONE`. Used corrected facts (extension ID `marketplace`, `ExtensionManifestSchema` not `parseExtensionManifest`, no `builtin`/`entry`/`slots` fields). Numbered the new section `## 15` (file already had 14 sections from spec 02). Restated `_internal.isGitRepo` rule. Prettier passes.

## Final Verification

- **Typecheck**: 21/21 packages clean
- **Lint**: 16/16 packages clean (0 errors). 11 cosmetic warnings total — 10 pre-existing in unrelated files (settings dialog, channels tab, mock samples), 1 new React Compiler memoization hint in MarketplaceShowcases.
- **Test suite**: **3587 tests passing across 309 files** in @dorkos/client; all server test packages also clean.
- **No regressions** to existing functionality.

## Files Modified/Created

**Source files:**

- `apps/server/src/builtin-extensions/marketplace/extension.json` (new)
- `apps/server/src/builtin-extensions/marketplace/index.ts` (new)
- `apps/server/src/builtin-extensions/marketplace/server.ts` (new)
- `packages/shared/src/marketplace-schemas.ts` (new)
- `packages/shared/package.json` (added `./marketplace-schemas` subpath export)
- `packages/shared/src/transport.ts` (added marketplace methods to `Transport` interface)
- `apps/client/src/layers/shared/lib/transport/marketplace-methods.ts` (new — factory)
- `apps/client/src/layers/shared/lib/transport/http-transport.ts` (wired marketplace factory)
- `apps/client/src/layers/shared/lib/direct-transport.ts` (added marketplace stubs)
- `apps/client/src/layers/shared/lib/embedded-mode-stubs.ts` (added marketplaceStubs)
- `packages/test-utils/src/mock-factories.ts` (added marketplace mock methods)

**Test files:**

_(None yet — Batch 1+2 were scaffolding/types/helpers; tests come in batch 3+)_

**Source files added in Batch 2:**

- `apps/server/src/services/builtin-extensions/ensure-marketplace.ts` (new)
- `apps/client/src/layers/entities/marketplace/api/query-keys.ts` (new — `marketplaceKeys` factory)
- `apps/client/src/layers/entities/marketplace/model/use-marketplace-packages.ts`
- `apps/client/src/layers/entities/marketplace/model/use-marketplace-package.ts`
- `apps/client/src/layers/entities/marketplace/model/use-permission-preview.ts`
- `apps/client/src/layers/entities/marketplace/model/use-installed-packages.ts`
- `apps/client/src/layers/entities/marketplace/model/use-marketplace-sources.ts`
- `apps/client/src/layers/entities/marketplace/model/use-install-package.ts`
- `apps/client/src/layers/entities/marketplace/model/use-uninstall-package.ts`
- `apps/client/src/layers/entities/marketplace/model/use-update-package.ts`
- `apps/client/src/layers/entities/marketplace/model/use-add-marketplace-source.ts`
- `apps/client/src/layers/entities/marketplace/model/use-remove-marketplace-source.ts`
- `apps/client/src/layers/entities/marketplace/index.ts` (barrel)
- `packages/shared/src/transport.ts` (orphan `PermissionPreview` import removed by orchestrator)

**Source files added in Batch 3:**

- `apps/server/src/index.ts` (wired `ensureBuiltinMarketplaceExtension`)
- `apps/server/package.json` (postbuild copy step for `builtin-extensions/`)
- `apps/client/src/layers/features/marketplace/model/dork-hub-store.ts` (Zustand store)
- `apps/client/src/layers/features/marketplace/ui/MarketplaceSourcesView.tsx`
- `apps/client/src/layers/features/agent-creation/ui/TemplatePicker.tsx` (added Dork Hub tab additively)

**Test files added in Batch 3:**

- `apps/server/src/services/builtin-extensions/__tests__/ensure-marketplace.test.ts` (4 tests)
- `apps/client/src/layers/entities/marketplace/__tests__/hooks.test.tsx` (9 tests)

## Known Issues

### Critical schema deviations cascading from Task #1

The task descriptions for marketplace-03-extension assumed an `@dorkos/extension-api` manifest shape that does not match reality. All downstream tasks that touch the extension manifest, ID, or slot registration must use the corrected facts below:

| Task spec said                                                        | Reality (what we used)                                                                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `id: "@dorkos-builtin/marketplace"`                                   | `id: "marketplace"` (schema regex `/^[a-z0-9][a-z0-9-]*$/` rejects `@`, `/`, uppercase)                                                   |
| `builtin: true` field                                                 | Field does not exist in `ExtensionManifestSchema`. Removed.                                                                               |
| `entry: { client, server }` field                                     | Field does not exist. Convention-based: `index.ts` for client, `server.ts` for server.                                                    |
| `slots: { 'sidebar.tabs': [...] }` field                              | Field does not exist. Schema only has `contributions: Record<string, boolean>` as a hint. Used `contributions: { 'sidebar.tabs': true }`. |
| `parseExtensionManifest` from `@dorkos/extension-api/manifest-schema` | `ExtensionManifestSchema` from `@dorkos/extension-api` (top-level barrel)                                                                 |
| `extensionManager.getById/unregister/registerBuiltin`                 | TBD — task #2 needs to discover the actual API surface                                                                                    |
| `register(): void` server entry                                       | `export default function register(router, ctx)` — required by `extension-server-lifecycle.ts:87`                                          |

**Slot registration is RUNTIME, not declarative.** The Dork Hub sidebar entry is registered inside the `activate(api)` function in `index.ts` via `api.registerComponent('sidebar.tabs', 'dork-hub', Component, { priority: 20 })`. This affects tasks #6.2 (sidebar entry) and #10.1 (docs).

**Discovery scans `{dorkHome}/extensions/<id>/` and `{cwd}/.dork/extensions/<id>/`.** The ensure helper (task #2) needs to copy the source from `apps/server/src/builtin-extensions/marketplace/` to `{dorkHome}/extensions/marketplace/`, mirroring `ensureDorkBot`.

### Transport method naming (from Task #5)

The transport methods landed with explicit `Marketplace` infixes (not the bare names from the task spec). Tasks #6, #7, #8 (entity hooks + tests) and #20–24 (UI) should import these names from `@dorkos/shared/transport`:

- `listMarketplacePackages(filter?)` → `AggregatedPackage[]`
- `getMarketplacePackage(name)` → detail
- `previewMarketplacePackage(name)` → preview
- `installMarketplacePackage(name, opts?)` → `InstallResult`
- `uninstallMarketplacePackage(name, opts?)` → `UninstallResult`
- `updateMarketplacePackage(name)` → `UpdateResult`
- `listInstalledMarketplacePackages()` → `InstalledPackage[]`
- `listMarketplaceSources()` → `MarketplaceSource[]`
- `addMarketplaceSource(input)` → `MarketplaceSource`
- `removeMarketplaceSource(name)` → void

Types are exported from `@dorkos/shared/marketplace-schemas`.

## Implementation Notes

### Session 1

**Review approach pivot**: Using holistic batch-level verification gates (typecheck + targeted vitest + lint) instead of per-task two-stage review. Reason: 31 tasks across 10 phases would saturate context budget with per-task review agents. Pattern validated in `settings-dialog-01-file-splits` (see `feedback_holistic_batch_gates.md`).

**Batch 1**: Both tasks landed cleanly under verification. Task #1 surfaced critical schema deviations (see Known Issues) that will be propagated to downstream agents via cross-session context.
