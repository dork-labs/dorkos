---
slug: marketplace-update-all
number: 260923-162659
created: 2026-09-23
status: ideation
linear-issue: DOR-2194
project: Marketplace Package Management
---

# Check and apply updates across every installed package in one request

**Slug:** marketplace-update-all
**Author:** Claude Code
**Date:** 2026-09-23

---

## 1) Intent & Assumptions

- **Task brief (DOR-2194):** add one package-agnostic door to the local server. An advisory read answers "what needs updating?" for every installed package in every scope (global, a project, every registered agent's project) in one request, with the scope scan done once. An apply form reinstalls every stale package, or a named subset; it authorizes like install and fires the same `onPluginsChanged` refresh per reinstall. The CLI's name-less `dorkos update` moves onto it. The per-package route stays.
- **The contract serves three later items, which read the same response without re-deriving anything:**
  - DOR-2195: MCP `marketplace_update` (optional `name`, advisory by default, `apply: true`) and an opt-in `checkUpdates` on `marketplace_list_installed`, which adds `latestVersion` and `hasUpdate` to each entry.
  - DOR-2196: the Installed view shows `installedVersion → latestVersion` per row, a count on the tab, and an "Update all" with a confirm step. It reads the check once on mount.
  - DOR-2193: `dorkos marketplace outdated` prints only the stale ones as `name  installed -> latest  (marketplace)` and exits non-zero when any are stale.
- **Assumptions:**
  - The version-truth work (DOR-2244, spec `marketplace-version-truth`) is merged, so a check is truthful: three statuses, nothing dropped, memos on the instance.
  - `marketplace.install` stays tier `act`, which is either allowed or denied and never asks a person (`enforceCapabilityTier`, `tier-enforcement.ts:1045`).
  - This is a local-server surface. `packages/cloud-api` is untouched.
- **Out of scope:**
  - Building DOR-2193, DOR-2195 or DOR-2196.
  - Pruning the package cache (DOR-2249). This door does not poll; DOR-2196 reads it once on mount.
  - A cached tree that can differ from its commit key (DOR-2248, being built in parallel in the fetcher, resolvers, template downloader and cache).
  - Changing the per-package route's response contract.

## 2) Pre-reading Log

- `apps/server/src/services/marketplace/flows/update.ts`: `UpdateFlow.run({ name?, apply?, projectPath? })`. The name-less form exists, but it walks only `dorkHome` plus the request's `projectPath` (`listInstalled`). It never walks agent scopes. **The issue's premise is half true:** the flow can check many packages, but not "every install across every scope". It also carries its own install-root walker, a second copy of the scanner's.
- `apps/server/src/routes/marketplace.ts:856-920`: the per-package route scans every scope (`scanInstallationsAcrossScopes`) and the project (`scanInstalledPackages`) to decide 404 vs a scoped `unknown`, then `UpdateFlow.run` walks again. Each scan runs `validatePackage` on every Claude-Code-only install.
- `apps/server/src/services/marketplace/installed-scanner.ts`: one scan helper per view (`scanInstalledPackages` merged per project, `scanInstallationsAcrossScopes` one entry per installation). Each already reads the identity and the install sidecar, then throws away `declaredVersion` and most of the sidecar, which the update check needs.
- `packages/cli/src/commands/update.ts`: a name-less run lists `GET /installed`, then sends one `POST /packages/:name/update` per (name, scope). That is N requests, and N+1 scans.
- `apps/server/src/services/marketplace/marketplace-installer.ts:475` (`update`) → `lib/locate-install.ts`: an update uninstalls by probing the request's project roots and then the global ones, and reinstalls into the request's `projectPath` scope.
- `apps/server/src/services/core/capabilities/tier-enforcement.ts:1295` (`authorizeCapability`): the input is parsed against the capability's own schema, and `marketplace.install` requires a single `name`.
- `apps/client/src/layers/features/marketplace/ui/InstalledPackagesView.tsx:204-285`: rows are keyed by `installPath`, "unique per scope, unlike the name". A per-row update passes `projectPath: pkg.agentPath`.
- `apps/server/src/services/session/agent-session-fanout.ts:99`: a private `mapWithConcurrency` (ordered, bounded).
- `specs/marketplace-version-truth/02-specification.md` §Performance: "The check stays sequential, as today. Parallelism belongs to DOR-2194's all-packages route, which owns the cost model for a whole-install scan."
- ADR-0233: an update is advisory by default; an applied update authorizes as `marketplace.install`.

## 3) Codebase Map

- **Primary components:** `flows/update.ts` (the check and apply), `installed-scanner.ts` (the one scan), `routes/marketplace.ts` (the HTTP doors), `packages/cli/src/commands/update.ts` (the name-less CLI run).
- **Shared dependencies:** `lib/install-roots.ts` (`installKey`, `updateNameOf`, `projectScopeRoot`), `installed-metadata.ts` (the sidecar), `@dorkos/shared/marketplace-schemas` (the wire types), `services/core/openapi-registry.ts` (the API docs mirror).
- **Data flow:** one scan (records: the listing's view plus `declaredVersion` and the sidecar) → per-installation check (find target, resolve the latest version, compare) → optional sequential apply, each installation in its own scope → the route fires `onPluginsChanged` per reinstall.
- **Feature flags/config:** none.
- **Potential blast radius:** the per-package route and every `UpdateFlow` caller, the installed list (it now reads through the same record scan), the CLI's `update`, and the API docs.

## 4) Root Cause Analysis

Not a bug report, but discovery found one defect in the shared apply path, and this door has to avoid it:

- **Repro:** install a plugin globally, then `dorkos update <name> --apply --project <dir>` (or a name-less `dorkos update --apply --project <dir>`, which does it for every global package).
- **Observed:** the global install is gone, and the package now lives in `<dir>/.dork/plugins/<name>`. Reproduced with the real installer against a `file://` marketplace: `applied: ["<project>/.dork/plugins/valid-plugin"]`, global exists `false`, project exists `true`.
- **Cause:** `UpdateFlow.run` applies with `projectPath: req.projectPath` for whatever it matched in the merged view. `installer.update` then uninstalls by probing project roots, then global roots (it finds the global one), and reinstalls into the request's `projectPath` scope.
- **Decision:** an apply always reinstalls an installation in the scope it was found in. For a global installation, that means no `projectPath`. This fix is shared by both doors.

## 5) Research

- **Potential solutions for "scan once":**
  1. The route scans, then passes names to `UpdateFlow.run`, which scans again. This is today's per-package shape: it still scans twice, and the flow cannot see agent scopes.
  2. `UpdateFlow` owns the scan through a `listAgentScopes` dep. One call site for every surface, but the flow then hides which view was scanned, and `marketplace_list_installed { checkUpdates }` (DOR-2195) would scan twice: once for the list and once for the check.
  3. **The scanner yields records once; the flow checks the records it is handed.** The route (and later the MCP tool) calls `scanInstallationRecords(dorkHome, view)` once, then `updateFlow.checkInstallations({ installations })`. DOR-2195's list-with-checks uses the same records for both halves. The flow's private walker is deleted, so there is one walker.
- **Recommendation:** option 3.
- **Result shape:** the options were a flat `checks[]` plus a separate `applied[]` joined by `installPath`, or one entry per installation that carries its own apply outcome. An applied `InstallResult` names the path it was reinstalled to, and a type change can move it to another root, so a join can miss. **Recommendation:** one entry per installation, carrying identity, the check, and the apply outcome.

## 6) Decisions

| #   | Decision             | Choice                                                                                                                                                                                                                                                                                                          | Rationale                                                                                                                                                                                                                          |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Routes               | `GET /api/marketplace/updates[?projectPath]` (advisory); `POST /api/marketplace/updates` with `{ apply: true, names?, projectPath? }`                                                                                                                                                                           | As proposed in the issue. POST requires the literal `apply: true`, so an empty POST can never reinstall everything.                                                                                                                |
| 2   | What is in view      | No `projectPath`: every installation in every scope, one entry each (the `GET /installed` view). With `projectPath`: that project's merged view (the `GET /installed?projectPath` view).                                                                                                                        | The same two views the installed list already serves, so a row and its check always describe the same set.                                                                                                                         |
| 3   | Result               | `{ checks: InstallationUpdateCheck[] }`: the existing `UpdateCheckResult` plus the installation's identity (`installPath`, `type`, `scope`, `agentPath?`, `agentId?`, `agentName?`), plus `applied?` / `applyError?` on POST                                                                                    | One entry per installation. `installPath` is the key the Installed view and the list tool already use, so no consumer re-derives anything.                                                                                         |
| 4   | Scan once            | One record scan in `installed-scanner.ts`, used by the list, the per-package flow and this door. The update flow's private walker is deleted.                                                                                                                                                                   | The cost DOR-2244's review named, and one walker instead of two.                                                                                                                                                                   |
| 5   | Apply scope          | Each installation is reinstalled in its own scope. The same fix goes into the per-package door.                                                                                                                                                                                                                 | The reproduced global → project move.                                                                                                                                                                                              |
| 6   | Apply isolation      | Sequential. A failure is recorded on that installation (`applyError`) and the rest continue. `onPluginsChanged` fires once per reinstall that landed, with that installation's scope.                                                                                                                           | A thrown error half-way through a batch would hide what already landed and skip its refresh.                                                                                                                                       |
| 7   | Authorization        | Before any network work, every candidate is authorized as `marketplace.install` with the per-package input shape (`{ name, projectPath? }`), stopping at the first non-allowed decision; nothing runs. A decision that would need a person's approval refuses the batch with a 403 naming the per-package door. | ADR-0233 parity. A batch cannot carry one approval token per package, and a 202 would send the caller into a loop. Unreachable while `marketplace.install` is `act`, but correct if it is ever raised.                             |
| 8   | Concurrency and cost | Checks run 4 at a time and come back in scan order. The in-flight memo shares one index fetch and one `ls-remote` per repository between them. Each check's remote work is bounded by the fetcher's own timeouts, and any failure is that installation's `unknown`.                                             | A slow agent scope costs its own checks' timeouts inside one of 4 slots and never blocks the rest. Parallel checks of one source share a single lookup, which a sequential run cannot do, because failed lookups are not memoized. |
| 9   | Names                | `names` selects installations in view by the name the update check uses (`updateNameOf`). A name that matches nothing in view is a 404 before anything runs.                                                                                                                                                    | The per-package route's 404 rule, applied to a list.                                                                                                                                                                               |
| 10  | CLI                  | A name-less `dorkos update [--apply] [--project]` makes one request. Lines for non-global installations name their agent or project. `--apply` exits 1 when any reinstall failed. A named run keeps the per-package route.                                                                                      | The issue's goal. The CLI's types come from `@dorkos/shared` instead of a local mirror.                                                                                                                                            |
