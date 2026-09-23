---
slug: marketplace-installed-updates
number: 260923-235409
created: 2026-09-23
status: specified
linear-issue: DOR-2196
project: Marketplace Package Management
---

# The Installed view says what is out of date and updates it

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-09-23
**Input:** [`01-ideation.md`](./01-ideation.md) (decisions 1–12 carried forward)

## Overview

The Marketplace's Installed view asks the local server, once, which installations have a newer version (`GET /api/marketplace/updates`, DOR-2194). Each row then says where it stands: an update is available (`1.2.0 → 1.3.0`), it is up to date, or it could not be checked and why. The Installed tab carries a count of stale installations, visible from Browse. "Update all" opens a confirm step that names every installation it will touch, then reinstalls exactly those. A row's Update button appears only when there is something to install, and uses the same door.

## Background / Problem Statement

Measured against `origin/main` at `a875cc496`:

- **The button is blind.** Every row renders **Update** (`InstalledPackagesView.tsx`, aria-label "Check for updates to X"). Nothing reads a check before the click, so a person cannot tell a current package from a stale one. `hasUpdate` is read nowhere in the client.
- **No overview.** No count, no summary, no "Update all". Finding what is stale means clicking every row.
- **One mutation for every row.** A single `useMutation` drives all rows, so clicking a second row while the first is updating drops the first row's pending state.
- **A door by name.** A row's update goes through `POST /packages/:name/update` with `projectPath: agentPath`. The server resolves the installation by name within that scope. The view already knows the exact `installPath`, and the batch door accepts it.

## Goals

- A stale installation is visibly stale before anything is clicked: its row says "Update available" with the installed and latest versions, and the Installed tab shows the count.
- The check is one request per Marketplace visit, shared by the tab and the view, never one per row.
- Update is offered only on rows with something to install. A current row cannot be updated; an unknown row says why it has no answer.
- "Update all" confirms each installation (name, place, version change) and applies exactly those.
- A check in flight reads as pending, never as a failure.
- Every state works at phone, tablet and desktop widths, by keyboard, and with a screen reader.

## Non-Goals

- Server changes; `packages/cloud-api` is untouched.
- Sorting or filtering by staleness, polling, or update notices outside the Marketplace.
- The package detail sheet's Installed panel.
- The CLI and MCP doors (DOR-2193, DOR-2195).

## Technical Dependencies

- `@tanstack/react-query` v5 (`useQuery`, `useMutation`, `useMutationState`), `sonner`, `lucide-react`, the shared `ResponsiveDialog`. No new packages.
- DOR-2194's routes and wire types (`InstallationUpdateCheck`, `InstallationUpdatesResult`).

## Detailed Design

### 1. Wire and transport (`packages/shared`)

`marketplace-schemas.ts` gains the apply body's client-side shape:

```ts
/** Options for `POST /api/marketplace/updates`, which always applies. */
export interface ApplyUpdatesOptions {
  /** The installations to update, as a check reported them. At least one. */
  installPaths: [string, ...string[]];
  /** The project whose view the paths came from; omit for the every-scope view. */
  projectPath?: string;
}
```

`installPaths` is required and non-empty, so the app can never send an unnamed "update everything". `names` (which the route also accepts) is left out: no client consumer needs it.

`Transport`:

- **Add** `checkMarketplaceUpdates(projectPath?: string): Promise<InstallationUpdatesResult>` → `GET /marketplace/updates[?projectPath=]`.
- **Add** `applyMarketplaceUpdates(opts: ApplyUpdatesOptions): Promise<InstallationUpdatesResult>` → `POST /marketplace/updates` with `{ apply: true, ...opts }`.
- **Remove** `updateMarketplacePackage`. After this change nothing in the client calls it. The server route stays for the CLI and MCP.

Implementations: `HttpTransport` (`marketplace-methods.ts`); the embedded stubs answer the check with `{ checks: [] }` (as `listInstalledPackages` answers `[]`) and throw on apply; `createMockTransport` gets `vi.fn()`s, the check resolving `{ checks: [] }`.

### 2. Entity layer (`entities/marketplace`)

- `marketplaceKeys.updates(projectPath?)` → `['marketplace', 'updates']` or `['marketplace', 'updates', { projectPath }]`, a sibling of `installed()` so no existing invalidation touches it. `marketplaceKeys.applyUpdates()` → `['marketplace', 'apply-updates']`, the mutation key.
- `useInstalledUpdates(projectPath?, { enabled? })`: `useQuery` on `updates(projectPath)`. `staleTime` 10 minutes (`UPDATE_CHECK_STALE_MS`), `refetchOnWindowFocus: false`, `refetchOnReconnect: false`, `retry: false`. The check reaches out to every package's source; a failed request shows its error and a "Try again", instead of retrying behind the person's back.
- `useApplyUpdates()`: `useMutation({ mutationKey: applyUpdates(), mutationFn: transport.applyMarketplaceUpdates })`. On success:
  - **Patch** every cached `updates(*)` result: each returned check replaces the cached check with the same `installPath`. An `applied` one becomes `current` at the latest version (`installedVersion = latestVersion`, `installedVersionSource = latestVersionSource`, `hasUpdate: false`, no `note`, no `applyError`). Anything else is stored as returned, so a fresh `unknown`, a now-`current` answer, or an `applyError` lands on its row.
  - **Invalidate** `installed()` (versions changed), `installedDetail(name)` and `packageDetail(name)` per applied package, and `['commands']` when anything was applied (a reinstall can change slash commands, UX-12).
- `useApplyingInstallPaths()`: `useMutationState` over the `applyUpdates()` key, status `pending`, returning the `Set` of every in-flight `installPath`. Rows read it, so concurrent applies each keep their pending state.
- `useInstallPackage` gains one line: on success, `invalidateQueries({ queryKey: updates(), refetchType: 'none' })`. The new row has no check yet; the next view mount re-checks.
- `useUpdatePackage` is deleted.

### 3. The join (`features/marketplace/lib/installed-updates.ts`, pure)

```ts
export type RowUpdateState =
  | { kind: 'checking' }
  | { kind: 'applying'; check: InstallationUpdateCheck }
  | { kind: 'update-available'; check: InstallationUpdateCheck }
  | { kind: 'current'; check: InstallationUpdateCheck }
  | { kind: 'unknown'; check: InstallationUpdateCheck }
  | { kind: 'unchecked' };

export interface UpdatesSummary {
  /** Stale installations still in the list, in list order: what "Update all" offers. */
  available: InstallationUpdateCheck[];
  current: number;
  unknown: number;
}

export function rowUpdateState(
  pkg: InstalledPackage,
  checks: ReadonlyMap<string, InstallationUpdateCheck>,
  flags: { isChecking: boolean; applying: ReadonlySet<string> }
): RowUpdateState;
export function summarizeUpdates(
  installed: readonly InstalledPackage[],
  checks: ReadonlyMap<string, InstallationUpdateCheck>
): UpdatesSummary;
export function indexChecks(
  checks?: readonly InstallationUpdateCheck[]
): Map<string, InstallationUpdateCheck>;
export function formatCheckVersion(version: string, source?: UpdateVersionSource): string; // 'v1.2.0' | 'a1b2c3d'
export function installationPlace(i: {
  scope?: PackageScope;
  agentName?: string;
  agentPath?: string;
}): string | null;
```

- Precedence in `rowUpdateState`: `applying` (this `installPath` is in flight) → `checking` (a check request is in flight) → the row's check by status → `unchecked` (no check for this row: a failed request, or a row installed after the last check).
- `summarizeUpdates` joins by `installPath` and counts only rows in the installed list. The tab count is `available.length`.
- `formatCheckVersion`: a `commit` version shows as its first 7 characters; anything else gets a `v` prefix unless it already has one.
- `installationPlace` moves the view's `agentLabel` here unchanged (agent name, else the project folder's name, `null` for a global installation), so rows, the dialog and toasts name a place the same way.

### 4. Feature model

- `useInstalledUpdatesView()` (`model/use-installed-updates.ts`): reads `useInstalledPackages()` and `useInstalledUpdates(undefined, { enabled: installedCount > 0 })`, and returns `{ checks, summary, isChecking, error, recheck }`. `Marketplace` and `InstalledPackagesView` both call it; TanStack dedupes the one query.
- `useApplyUpdatesWithToast()` (`model/use-apply-updates-with-toast.ts`, replaces `use-update-with-toast.ts`): `apply(checks: InstallationUpdateCheck[])` sends `{ installPaths }` and drives one loading toast, replaced in place by:

| Outcome                   | Toast                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| one installation, applied | success: "Updated Reviewer to v1.3.0" (" on Alpha" for an agent's)    |
| one, `applyError`         | error: "Couldn't update Reviewer: <reason>"                           |
| one, now `current`        | success: "Reviewer is already up to date"                             |
| one, now `unknown`        | warning: "Couldn't check Reviewer for updates: <note>"                |
| several, all applied      | success: "Updated 3 packages"                                         |
| several, some applied     | warning: "Updated 2 of 3 packages. Each package shows what happened." |
| several, none applied     | error: "Couldn't update 3 packages. Each package shows why."          |
| the request failed        | error: "Update failed: <message>"                                     |

### 5. The view (`ui/InstalledPackagesView.tsx`)

**Summary bar** (new `ui/InstalledUpdatesSummary.tsx`), above the list, a `role="status"` region so each settled answer is announced once:

| State              | Text                                                                 | Actions                                |
| ------------------ | -------------------------------------------------------------------- | -------------------------------------- |
| checking           | spinner, "Checking your packages for updates…"                       | none                                   |
| request failed     | "Couldn't check for updates: <message>"                              | "Try again"                            |
| updates available  | "**3 updates available**" · "5 up to date" · "1 couldn't be checked" | "Update all…" (primary), "Check again" |
| none, some unknown | "Nothing to update" · "5 up to date" · "1 couldn't be checked"       | "Check again"                          |
| all current        | check icon, "All packages are up to date."                           | "Check again"                          |

Counts use "package" for one and "packages" for several, and count installations (a package on two agents is two rows, and two lines of the list).

**Row** (`PackageRow`): the existing badges and metadata stay. A status line joins the metadata column:

| Row state          | Status line                                                                                  | Update button                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `checking`         | spinner, "Checking for updates…" (muted)                                                     | none                                                                                      |
| `update-available` | arrow icon, "Update available: v1.2.0 → v1.3.0" (`status-info-fg`); a `note` below it, muted | "Update to v1.3.0" (outline), aria-label "Update Reviewer on Alpha from v1.2.0 to v1.3.0" |
| `applying`         | spinner, "Updating to v1.3.0…"                                                               | disabled, "Updating…"                                                                     |
| `current`          | check icon, "Up to date" (muted); a `note` after it, muted                                   | none                                                                                      |
| `unknown`          | help icon, "Couldn't check for updates: <note>" (muted)                                      | none                                                                                      |
| `unchecked`        | nothing                                                                                      | none                                                                                      |

An `applyError` on a row that is still `update-available` adds an error line, "Couldn't update: <reason>" (`status-error-fg`), and the Update button stays so the person can retry.

**Layout:** the row stacks (metadata, then actions) below the `sm` breakpoint and sits side by side from `sm` up; actions wrap. Row padding drops to `p-4` on phones.

**Confirm step** (new `ui/UpdateAllDialog.tsx`, a `ResponsiveDialog`, so a drawer on phones): "Update all…" snapshots `summary.available` and opens it.

- Title: "Update 3 packages?" (singular for one).
- Description: "DorkOS replaces each package below with its newest version, in the same place it is installed now."
- A list (`<ul aria-label="Packages to update">`), one item per installation: display name, place ("All agents" for global, else the agent's name, with the project path muted beneath), and "v1.2.0 → v1.3.0".
- Footer: "Cancel" and "Update 3 packages". Confirming sends exactly the snapshot's `installPaths` and closes the dialog; progress continues on the rows and in the toast.

**Tab count** (`Marketplace.tsx`): when `summary.available.length > 0`, the Installed trigger shows a small count pill after its label (`aria-hidden`), plus screen-reader text ", 3 updates available". Nothing renders while checking or at zero.

### 6. Playground

`InstalledPackagesViewShowcase` gains seeded states: updates available (with an unknown and a current row, and an `applyError` row), all up to date, checking (a query that never settles), and the check failing. `UpdateAllDialog` gets its own section. The mocks add checks for `MOCK_INSTALLED_PACKAGES`.

## User Experience

Kai opens the Marketplace on Browse. The Installed tab reads "Installed 2". He opens it: the summary says "2 updates available · 5 up to date · 1 couldn't be checked". Two rows say "Update available: v0.7.2 → v0.7.3", one of them on Alpha. A row for a package he linked from his working copy says "Couldn't check for updates: linked install — update its source instead". Every other row says "Up to date" and has no Update button. He presses "Update all…"; the dialog lists flow on Alpha and reviewer for All agents, each with its version change. He confirms. Both rows show "Updating to…", then "Up to date", and one toast says "Updated 2 packages". The tab count is gone.

## Testing Strategy

Each test carries a purpose comment and must be able to fail.

- **`lib/installed-updates.test.ts`:** row-state precedence (applying over checking over status; no check → `unchecked`); the summary counts only rows still installed and keeps list order; `formatCheckVersion` for semver, a leading `v`, and a commit SHA; `installationPlace` for global, a named agent and a bare path.
- **`entities/marketplace` hooks:** `useInstalledUpdates` calls `checkMarketplaceUpdates` once and never when disabled; `useApplyUpdates` sends `{ installPaths }`, patches an applied check to `current` at the latest version, stores a returned `applyError` and an `unknown` as returned, and invalidates installed and commands; `useApplyingInstallPaths` holds two concurrent applies' paths; install marks the check stale without refetching.
- **Transport:** `HttpTransport` hits `GET /marketplace/updates` (with `?projectPath=` when given) and `POST /marketplace/updates` with `{ apply: true, installPaths }`.
- **`use-apply-updates-with-toast.test.tsx`:** each toast in §4's table.
- **`InstalledPackagesView.test.tsx`:**
  - a stale row shows both versions and an "Update to" button; a current row shows "Up to date" and no Update button; an unknown row shows its note and no Update button; a checking state shows "Checking for updates…" on rows and no Update button;
  - the view never calls the check per row (the view hook is called with no per-row argument; the entity test pins one call);
  - a row's Update applies exactly that row's `installPath`;
  - "Update all…" lists exactly the stale installations with their places and version changes, and confirming applies exactly those `installPaths`; Cancel applies nothing;
  - all current says "All packages are up to date." and offers no "Update all";
  - an `applyError` shows on its row, with the button still offered;
  - the summary is a `status` region; the existing uninstall, shape and dependency-warning tests stay green.
- **`Marketplace.test.tsx`:** the Installed tab shows the count with its screen-reader text, and nothing at zero.
- **Mocking:** the transport through `createMockTransport`; view tests mock the feature hooks, as today.

## Performance Considerations

- One `GET /updates` per Marketplace visit (10-minute freshness), only when something is installed. It never refetches on focus or reconnect.
- An apply patches the cache from its own answer; there is no second check.
- The server's check cap (4, server-wide) and its 60-second memo are unchanged.

## Security Considerations

- The app sends only `installPaths` that a check reported, and the server validates every one against its own scan before any gate or network call (404 otherwise).
- Every reinstall is authorized as `marketplace.install` by the server, as before. A `batch_update_needs_approval` refusal is shown as the error it is.
- No new data leaves the machine.

## Documentation

- `docs/marketplace/index.mdx`: a "Keeping packages up to date" section for the Installed tab (the count, the three row states, "Update all" and its confirm step), and the CLI tab's pointer to the Installed panel updated.
- `contributing/data-fetching.md`: the marketplace hooks section names `useInstalledUpdates` / `useApplyUpdates` in place of `useUpdatePackage`.
- A changelog fragment in plain words.
- No new ADR (ideation decision 12).

## Implementation Phases

- **Phase 1:** transport and entity layer (types, methods, keys, hooks, removal of `updateMarketplacePackage` / `useUpdatePackage`), with tests.
- **Phase 2:** the join lib, the view hook, the toast hook, the view, the summary, the dialog, the tab count, with tests.
- **Phase 3:** the playground, docs, changelog, browser screenshots of every state.

All three ship in one PR with this spec.

## Open Questions

1. ~~Should a current row keep an Update button that answers "already up to date"?~~ (RESOLVED)
   **Answer:** No. It has no button.
   **Rationale:** "Impossible" is stronger than "a clear no-op", and a button that does nothing is the blind button again.
2. ~~Should "Check again" bypass the server's 60-second memo?~~ (RESOLVED)
   **Answer:** No.
   **Rationale:** The memo is the server's cost control, and an apply or a source refresh already clears it. A person who just pushed a release and checks within a minute sees the answer a minute later; that is not worth a new server knob.
3. ~~Should the dialog stay open until the batch finishes?~~ (RESOLVED)
   **Answer:** No. It closes on confirm; each row shows its own progress and one toast reports the result.
   **Rationale:** The list itself is the progress view, and a modal held open over it hides it.

## Related ADRs

- ADR-0233: update is advisory by default; an applied update authorizes as `marketplace.install`.
- ADR 260923-163034: an update is checked and applied per installation, in the installation's own scope.
- ADR 260923-122615: a package's latest version is what an install would resolve (so an applied row is current at that version).

## References

- DOR-2196 (this item); DOR-2194 (the doors, `specs/marketplace-update-all/02-specification.md` §6); DOR-2249 (cache retention).
- `research/20260227_update_notification_ux_patterns.md`.
