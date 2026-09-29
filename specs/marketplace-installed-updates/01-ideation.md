---
slug: marketplace-installed-updates
number: 260923-235409
created: 2026-09-23
status: ideation
linear-issue: DOR-2196
project: Marketplace Package Management
---

# The Installed view says what is out of date and updates it

**Slug:** marketplace-installed-updates
**Author:** Claude Code
**Date:** 2026-09-23

---

## 1) Intent & Assumptions

- **Task brief (DOR-2196):** the Installed view offers an Update button on every row and never says whether anything is out of date. So the button is a guess: people press it on packages that were already current and never press it on the one that is four versions behind. The view should read the all-packages update check (DOR-2194) once and use it:
  - a per-row "update available: installed → latest" affordance;
  - a count on the Installed tab, so staleness is visible without opening it;
  - an "Update all" with a confirm step naming exactly what it will touch, by installation (package, scope, agent);
  - rows the check could not answer say why ("linked install — update its source instead", "couldn't reach github.com");
  - when everything is current, say so plainly;
  - pressing Update on a current package is impossible or clearly a no-op.
- **Acceptance (from the issue):** a stale package is visibly stale before you click anything; the check is one request, not one per installed package; Update on a current package is impossible or a clear no-op; covered at the level of the existing marketplace feature tests.
- **Programme constraints (DOR-2194 spec §6):** read `GET /api/marketplace/updates` once, for the same view `GET /installed` returns, and key each check by `installPath`. "Update all" sends `POST /api/marketplace/updates { apply: true, installPaths }` with exactly the installations the confirm step showed. Checks share one server-wide cap of 4, so a check can wait behind another scan: show it as pending, never as failed, and never fire a check per row on mount.
- **Assumptions:**
  - DOR-2194 is merged (`a875cc496`): both doors exist, reinstall each installation in its own scope, and answer per installation with `applied` / `applyError`.
  - DOR-2249 (cache retention) is merged, so reading the check when the Marketplace opens does not grow the cache without bound. This view still does not poll.
  - `marketplace.install` stays tier `act`, so a person's batch apply is never refused as `batch_update_needs_approval`. If it ever is, the error is shown, not swallowed.
  - The Installed view lists every scope (`GET /installed` with no `projectPath`), so the check is read with no `projectPath` too.
- **Out of scope:**
  - Server changes. Both doors already answer everything this view needs.
  - Sorting or filtering the list by staleness (the issue mentions it as a symptom, not a requirement; the count and the summary line answer "what is stale?" without reordering the person's list).
  - Background polling, and update notices outside the Marketplace (sidebar badges, toasts on app start).
  - The package detail sheet's Installed panel (Reinstall / Uninstall per scope). It does not offer Update today.

## 2) Pre-reading Log

- `apps/client/src/layers/features/marketplace/ui/InstalledPackagesView.tsx`: rows keyed by `installPath`. Each row has an always-on **Update** button labelled "Check for updates to X", which calls `useUpdateWithToast` → `useUpdatePackage` → `transport.updateMarketplacePackage(name, { apply: true, projectPath: agentPath })` → `POST /packages/:name/update`. Nothing reads a check before the click. One `useMutation` instance drives every row, so a second row's click replaces the first row's pending state.
- `apps/client/src/layers/features/marketplace/model/use-update-with-toast.ts`: the toast wording for one package's outcome ("Updated X to vY", "X is already up to date", "Couldn't check X for updates: …"). Worth keeping in spirit.
- `apps/client/src/layers/features/marketplace/ui/Marketplace.tsx`: the Browse / Installed tabs (`TabsTrigger value="installed"`), the view in the URL (`?view=`). The tab has no count.
- `apps/client/src/layers/entities/marketplace/*`: `useInstalledPackages(projectPath?)` (key `marketplaceKeys.installed()`, 60 s stale), mutation hooks that invalidate `installed()`, `packageDetail(name)` and `['commands']`. No updates query exists.
- `packages/shared/src/marketplace-schemas.ts`: `InstallationUpdateCheck` (the check + `installPath`, `type`, `scope`, `agentPath`, `agentId`, `agentName`, `applied?`, `applyError?`) and `InstallationUpdatesResult`. No type for the apply body.
- `packages/shared/src/transport.ts`: `updateMarketplacePackage(name, opts)` is the only update method. No method for either `/updates` door. Implemented by `HttpTransport` (`shared/lib/transport/marketplace-methods.ts`), the embedded stubs (`shared/lib/embedded-mode-stubs.ts`) and the test mock (`packages/test-utils/src/mock-factories.ts`).
- `apps/server/src/routes/marketplace.ts` (`GET`/`POST /updates`): GET is a read, not gated; POST needs `apply: true`, validates `installPaths` against one scan (404 names the unmatched ones), authorizes every reinstall before any network work, and answers 200 with per-installation `applied` / `applyError`.
- `apps/server/src/services/marketplace/flows/update.ts`: statuses `current` / `update-available` / `unknown`; `note` is the reason for `unknown` and a caveat on a known answer (rollback, default branch). `installedVersion` is a full commit SHA when `installedVersionSource === 'commit'`. Memos live 60 s, and an apply clears them.
- `specs/marketplace-update-all/02-specification.md` §6: the consumer contract quoted above; open question 3 hands the per-row door choice to this item.
- `research/20260227_update_notification_ux_patterns.md`: the settled pattern is a passive, low-signal indicator with detail one click away; the complaints are interruptions and over-badging.
- `.claude/skills/designing-frontend/SKILL.md`: control surface density; nothing at rest that does not earn its place; a numbered badge is reserved for things directed at the person (an available update qualifies: it is an action waiting on them).
- `docs/marketplace/index.mdx`: documents `dorkos update` and the detail sheet's Installed panel, not the Installed tab.
- `apps/client/src/dev/showcases/MarketplaceShowcases.tsx`: `InstalledPackagesView` is showcased empty and populated with a seeded `QueryClient`.

## 3) Codebase Map

- **Primary components:** `features/marketplace/ui/InstalledPackagesView.tsx` (rows, the summary, the confirm step), `features/marketplace/ui/Marketplace.tsx` (the tab count).
- **New pieces:** an updates query and an apply mutation in `entities/marketplace`; the join and wording in `features/marketplace/lib`; a toast wrapper in `features/marketplace/model`; the summary bar and confirm dialog in `features/marketplace/ui`.
- **Shared dependencies:** `@dorkos/shared/marketplace-schemas` types, the `Transport` interface, `ResponsiveDialog`, `Button`, `Badge`, sonner toasts, the status color tokens (`status-info-fg`, `status-success-fg`, `status-error-fg`).
- **Data flow:** `GET /installed` (rows) + `GET /updates` (checks), joined by `installPath` → row state and summary → tab count. Apply: `POST /updates { apply: true, installPaths }` → per-installation outcome → patch the updates cache, invalidate the installed list and command registry → toast.
- **Feature flags/config:** none.
- **Potential blast radius:** the `Transport` interface (two methods added, one removed) and every implementation of it; the marketplace entity barrel; the Installed view's tests; the playground showcase.

## 4) Root Cause Analysis

Not a defect in code that exists; the view was built before the check it needs existed. The honest-by-design gap: the Update button cannot say what it will do, because the view never asks.

## 5) Research

- **Where the per-row Update goes:**
  1. Keep `POST /packages/:name/update` for one row, and add the batch door only for "Update all". Pro: smaller diff. Con: two doors with two answer shapes; the per-package door finds its installation by name within a scope, so a plugin and an agent sharing a name in one scope could resolve to the other one, while the view already knows the exact `installPath`.
  2. **Move the row onto `POST /updates { apply: true, installPaths: [row] }`.** Pro: one door, exact installation, the same per-installation outcome as "Update all". Con: the client's per-package update stack (`updateMarketplacePackage`, `useUpdatePackage`, `useUpdateWithToast`) is left with no consumer and has to go.
  - **Recommendation:** 2. The server's per-package route stays for the CLI and the MCP tool.
- **What a current row shows:**
  1. Keep the Update button and make it a no-op toast. Honest, but still a button that does nothing.
  2. **No button; a quiet "Up to date" line.** The button appears only when there is something to install, and names the version ("Update to v1.3.0").
  - **Recommendation:** 2. It makes "Update on a current package" impossible, the stronger half of the acceptance line.
- **When the check runs:**
  1. When the Installed tab opens. Con: the tab count needs the answer before the tab opens.
  2. **When the Marketplace opens (either tab), once, shared by the tab count and the view through one query key.** Con: an extra request on Browse. It is one request, and only when something is installed.
  - **Recommendation:** 2, with a 10-minute freshness window, no refetch on focus or reconnect, and no retry. "Check again" re-asks on demand.
- **After an apply:**
  1. Invalidate the check (a second network round per apply).
  2. **Patch the cached check from the apply's answer.** The answer names every installation it touched: an `applied` one is now at the version the check called latest, anything else carries its fresh check or `applyError`.
  - **Recommendation:** 2. No second round, and the rows move straight to their new state.

## 6) Decisions

| #   | Decision                | Choice                                                                                                                                   | Rationale                                                                                                                                                                  |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Door for a row's Update | `POST /updates { apply: true, installPaths: [row] }`; delete the client's per-package update stack                                       | One door and one answer shape for one row and for all; exact installation by `installPath`. DOR-2194 open question 3 left this to this item. No dead code left behind.     |
| 2   | Current rows            | No Update button; "Up to date"                                                                                                           | Makes a pointless update impossible rather than a no-op.                                                                                                                   |
| 3   | Unknown rows            | No Update button; "Couldn't check for updates: <reason>"                                                                                 | DorkOS never calls a package current when it couldn't check it; offering Update there would be the old blind button again.                                                 |
| 4   | When the check runs     | Once when the Marketplace opens and something is installed; one query shared by the tab and the view; 10-minute freshness; "Check again" | The tab count must be visible from Browse; one request, never per row; no polling.                                                                                         |
| 5   | A check in flight       | Every row reads "Checking for updates…" and offers no Update; the summary says the same                                                  | The DOR-2194 UX note: a check can wait behind another scan, so it is pending, not failed.                                                                                  |
| 6   | Update all              | A confirm dialog listing each stale installation by name, place and version change; sends exactly those `installPaths`                   | "Naming exactly what it will touch"; the server refuses any path it cannot find, so a stale list cannot widen into "everything".                                           |
| 7   | The apply body          | The transport method requires a non-empty `installPaths`                                                                                 | The app never sends an unnamed "update everything".                                                                                                                        |
| 8   | After an apply          | Patch the cached check from the answer; invalidate the installed list and command registry                                               | No second network round; the rows show the truth the server just returned.                                                                                                 |
| 9   | Tab count               | Stale installations that are still in the installed list (joined by `installPath`)                                                       | An uninstall refreshes the list, so a removed package stops counting without a new check.                                                                                  |
| 10  | Several applies at once | Track every in-flight apply by its `installPaths` (a mutation key + `useMutationState`)                                                  | Today one shared mutation forgets the first row when a second is clicked.                                                                                                  |
| 11  | A fresh install         | Mark the check stale (no immediate refetch)                                                                                              | The new row has no check yet; the next time the Installed view mounts, it re-checks.                                                                                       |
| 12  | ADR                     | None new                                                                                                                                 | Decisions 1–11 apply ADR 260923-163034 (per-installation, in its own scope) and ADR-0233 (advisory by default) to one surface; nothing here is a new architectural choice. |

No question needed the operator: the issue, the DOR-2194 contract and the design rules settle every choice above.

## 7) Next step

SPECIFY: `specs/marketplace-installed-updates/02-specification.md`.
