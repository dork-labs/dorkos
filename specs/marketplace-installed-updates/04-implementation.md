---
slug: marketplace-installed-updates
number: 260923-235409
status: implemented
linear-issue: DOR-2196
---

# Implementation notes

**Base:** `origin/main` at `a875cc496` (includes DOR-2194).

## What shipped

- Tasks 1.1–3.1 as decomposed. Transport: `checkMarketplaceUpdates`, `applyMarketplaceUpdates` (`ApplyUpdatesOptions.installPaths` is a non-empty tuple); `updateMarketplacePackage` and `UpdateOptions` removed.
- Entity: `useInstalledUpdates`, `useApplyUpdates` (patches the cached check), `useApplyingInstallPaths`; `useInstallPackage` marks the check stale; `useUpdatePackage` removed.
- Feature: `lib/installed-updates.ts`, `useInstalledUpdatesView`, `useApplyUpdatesWithToast` (replaces `useUpdateWithToast`), `InstalledUpdatesSummary`, `InstallationUpdateStatus`, `UpdateAllDialog`, the tab count in `Marketplace`.
- Playground: `MarketplaceUpdateShowcases.tsx` (every update state, the dialog); the seeded provider moved to `marketplace-query-provider.tsx`.

## Deviations from the spec (recorded, spec updated)

- `UpdatesSummary.available` carries `{ installation, check }` pairs (`StaleInstallation`), not bare checks, so every label (row, dialog, toast) uses the name the installed list shows. The server's check name can differ from it when a manifest name is invalid (`updateNameOf` falls back to the folder).
- The summary's details are whole sentences ("1 package is up to date.") rather than " · " fragments, which read badly once wrapped on a phone.
- Rows stack by container width (`@container` / `@2xl`), not the `sm` viewport breakpoint: at tablet width the app sidebar leaves ~450px of content.
- While an apply is in flight, "Update all…" is hidden and "Check again" is disabled, so a check never reads a half-finished reinstall.
- Toasts for several installations add two outcomes the spec table did not name: all turned out current ("These N packages are already up to date") and a mix with nothing applied ("Nothing was updated. Each package shows where it stands.").
- `UpdateOptions` (shared) was removed as well: its only consumer was the client door this item retired.

## Proof

Screenshots of every state from the real app (server + Vite from the worktree, `/api/marketplace/installed` and `/api/marketplace/updates` answered by Playwright) are in the worktree's gitignored `.temp/shots/`.
