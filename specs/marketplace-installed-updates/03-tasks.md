# Tasks: The Installed view says what is out of date and updates it

Spec: `specs/marketplace-installed-updates/02-specification.md` · generated from `03-tasks.json`

## P1 — Transport and entity layer

### Task 1.1: Add the updates doors to the Transport and remove updateMarketplacePackage

**Size:** small · **Depends on:** none · **Parallel with:** none

In `packages/shared/src/marketplace-schemas.ts` add `ApplyUpdatesOptions { installPaths: [string, ...string[]]; projectPath?: string }` (TSDoc: the app never sends an unnamed apply; `names` omitted, no consumer). In `packages/shared/src/transport.ts` add `checkMarketplaceUpdates(projectPath?: string): Promise<InstallationUpdatesResult>` (GET /marketplace/updates[?projectPath=]) and `applyMarketplaceUpdates(opts: ApplyUpdatesOptions): Promise<InstallationUpdatesResult>` (POST /marketplace/updates with `{ apply: true, ...opts }`), and delete `updateMarketplacePackage`. Implement in `apps/client/src/layers/shared/lib/transport/marketplace-methods.ts`; embedded stubs: check resolves `{ checks: [] }`, apply throws 'Marketplace is not supported in embedded mode'; `packages/test-utils/src/mock-factories.ts`: `checkMarketplaceUpdates: vi.fn().mockResolvedValue({ checks: [] })`, `applyMarketplaceUpdates: vi.fn()`. Test (transport test beside marketplace-methods, or the existing http transport test file): GET path with and without projectPath (encoded), POST body `{ apply: true, installPaths }`. Rebuild @dorkos/shared.

### Task 1.2: Entity hooks: useInstalledUpdates, useApplyUpdates, useApplyingInstallPaths

**Size:** medium · **Depends on:** 1.1 · **Parallel with:** none

In `entities/marketplace`: keys `updates(projectPath?)` (['marketplace','updates'] or with {projectPath}) and `applyUpdates()` (['marketplace','apply-updates']). `useInstalledUpdates(projectPath?, { enabled? })`: useQuery on updates(projectPath), staleTime `UPDATE_CHECK_STALE_MS` = 10 min, refetchOnWindowFocus false, refetchOnReconnect false, retry false. `useApplyUpdates()`: useMutation with mutationKey applyUpdates(), mutationFn transport.applyMarketplaceUpdates; onSuccess patches every cached updates(*) result via setQueriesData: a returned check with `applied` becomes { ...check, status: 'current', hasUpdate: false, installedVersion: latestVersion, installedVersionSource: latestVersionSource, note: undefined, applyError: undefined, applied: undefined }; any other returned check replaces the cached one as-is; then invalidates installed(), installedDetail(name) + packageDetail(name) per applied package, and ['commands'] when anything applied. `useApplyingInstallPaths()`: useMutationState({ filters: { mutationKey: applyUpdates(), status: 'pending' }, select: m => m.state.variables }) → Set of installPaths. `useInstallPackage` onSuccess also invalidates updates() with refetchType 'none'. Delete `use-update-package.ts` and its barrel export. Tests in `entities/marketplace/__tests__/`: one check call, none when disabled; apply body; patch to current; applyError / unknown stored as returned; invalidations; two concurrent applies both in the pending set; install marks updates stale without a refetch.

## P2 — The view

### Task 2.1: Pure join: row state, summary, version and place formatting

**Size:** small · **Depends on:** none · **Parallel with:** 1.1, 1.2

`features/marketplace/lib/installed-updates.ts`: `RowUpdateState` union (checking | applying | update-available | current | unknown | unchecked), `rowUpdateState(pkg, checks, { isChecking, applying })` with precedence applying → checking → check status → unchecked; `summarizeUpdates(installed, checks)` → { available (list order, only installed rows), current, unknown }; `indexChecks(checks?)`; `formatCheckVersion(version, source)` (commit → first 7 chars, else v-prefix unless present); `installationPlace({ scope, agentName, agentPath })` (moved from the view's agentLabel: agent name, else last path segment, null for global). Tests in `lib/__tests__/installed-updates.test.ts` for each rule.

### Task 2.2: Feature hooks: useInstalledUpdatesView and useApplyUpdatesWithToast

**Size:** medium · **Depends on:** 1.2, 2.1 · **Parallel with:** none

`model/use-installed-updates.ts`: `useInstalledUpdatesView()` reads useInstalledPackages() and useInstalledUpdates(undefined, { enabled: installed.length > 0 }), returns { checks (Map), summary, isChecking (isFetching), error, recheck }. `model/use-apply-updates-with-toast.ts` replaces `use-update-with-toast.ts` (delete it and its test): `apply(checks)` → loading toast, then per the table: one applied 'Updated X to vY' (+ ' on Agent'), one applyError error 'Couldn't update X: reason', one current 'X is already up to date', one unknown warning 'Couldn't check X for updates: note', several all applied 'Updated N packages', some 'Updated A of N packages. Each package shows what happened.' (warning), none 'Couldn't update N packages. Each package shows why.' (error), request failure 'Update failed: message'. Test each outcome with a mocked useApplyUpdates.

### Task 2.3: Installed view: row status, summary bar, Update all dialog, tab count

**Size:** large · **Depends on:** 2.2 · **Parallel with:** none

`ui/InstalledUpdatesSummary.tsx` (role=status region; checking / failed+Try again / available with 'Update all…' + 'Check again' / nothing to update / all current). `ui/UpdateAllDialog.tsx` (ResponsiveDialog; title 'Update N packages?'; description; ul aria-label 'Packages to update' with name, place ('All agents' or agent + muted path), 'v1 → v2'; Cancel / 'Update N packages'). `InstalledPackagesView`: rows get a status line per row state and show Update only when update-available ('Update to vX', aria-label 'Update X on Agent from v1 to v2'), 'Updating…' when applying, an applyError line; rows stack below sm. `Marketplace.tsx`: count pill on the Installed trigger (aria-hidden) + sr-only ', N updates available'. Tests: InstalledPackagesView.test.tsx (each row state; row Update applies that installPath; Update all lists exactly the stale set and applies exactly those paths; Cancel applies nothing; all current copy; applyError; status region; existing tests stay green), Marketplace.test.tsx (count + sr text; nothing at zero).

## P3 — Playground, docs, proof

### Task 3.1: Playground, docs, changelog, screenshots

**Size:** medium · **Depends on:** 2.3 · **Parallel with:** none

Playground: mocks for checks over MOCK_INSTALLED_PACKAGES; InstalledPackagesView showcase states (updates available incl. unknown/current/applyError, all current, checking via a never-settling prefetch, check failed); UpdateAllDialog section registered in dev/sections/marketplace-sections.ts. Docs: `docs/marketplace/index.mdx` 'Keeping packages up to date' + CLI tab pointer; `contributing/data-fetching.md` marketplace hooks. Changelog fragment in `changelog/unreleased/`. Run the app from the worktree on a free port and capture screenshots (current, update-available, unknown, pending, confirm dialog, mobile) under `.temp/`.
