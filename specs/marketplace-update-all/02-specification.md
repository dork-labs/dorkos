---
slug: marketplace-update-all
number: 260923-162659
created: 2026-09-23
status: specified
linear-issue: DOR-2194
project: Marketplace Package Management
---

# Check and apply updates across every installed package in one request

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-09-23
**Input:** [`01-ideation.md`](./01-ideation.md) (decisions 1–10 carried forward)

## Overview

DorkOS can check one installed marketplace package for a new version per request. Nothing in the product can answer "what needs updating?" in one call. This spec adds that door: an advisory read across every installation in every scope, with the scopes scanned once, and an apply form for every stale package or a named subset. The CLI's name-less `dorkos update` moves onto it. The response is shaped so that the MCP tool (DOR-2195), the Installed view (DOR-2196) and `dorkos marketplace outdated` (DOR-2193) can all read it as-is.

It also fixes a defect the new door would otherwise have repeated: an applied update reinstalls a package into the request's scope, not the scope it came from.

## Background / Problem Statement

Measured against `origin/main` at `3b36e3876`:

- **No door.** `POST /api/marketplace/packages/:name/update` is the only route to `UpdateFlow`, and `:name` is a path segment.
- **The flow cannot see every scope.** `UpdateFlow.run({})` walks `dorkHome` plus the request's `projectPath` (`flows/update.ts`, `listInstalled`). It never walks registered agents' projects, which the installed list does (`scanInstallationsAcrossScopes`). So the issue's premise ("omit `name` and the flow enumerates every install across every scope") holds only for the global scope and a single project.
- **N+1 scans.** A name-less `dorkos update` lists `GET /installed`, then sends one `POST /packages/:name/update` per (name, scope) (`packages/cli/src/commands/update.ts`). Every one of those requests scans every scope to decide between a 404 and a scoped `unknown` (`routes/marketplace.ts:883-893`), then `UpdateFlow` scans again. Each scan runs `validatePackage` on every Claude-Code-only install (the DOR-2244 review note on this item).
- **Two walkers.** `UpdateFlow.listInstalled` duplicates the installed scanner's walk over install roots, with its own dedupe and backup-skip rules.
- **An apply lands in the wrong scope.** `UpdateFlow.run` passes `req.projectPath` to `installer.update` for whatever it matched. The installer uninstalls by probing the project's roots and then the global ones (`lib/locate-install.ts`), and reinstalls into the request's project (`install-plugin.ts:252`, `install-agent.ts:170`). Result: `dorkos update <name> --apply --project <dir>` on a globally installed package deletes the global install and reinstalls it into the project. A name-less `dorkos update --apply --project <dir>` does this to every global package. Reproduced with the real installer against a `file://` marketplace: the only applied path was `<project>/.dork/plugins/valid-plugin`, the global directory was gone, and the project directory existed.

## Goals

- One request returns an update check for every installation in view, across scopes, with the scopes scanned once.
- The advisory form changes no installed state, and a test proves it.
- The apply form produces one outcome per installation it touched, reinstalls each in its own scope, isolates failures, and fires `onPluginsChanged` once per reinstall that landed.
- Applying authorizes as `marketplace.install` (ADR-0233), before any network work.
- A name-less `dorkos update` is one request.
- DOR-2193, DOR-2195 and DOR-2196 can consume the response without re-deriving scope, identity or staleness.
- `packages/cloud-api` is untouched.

## Non-Goals

- Building DOR-2193, DOR-2195 or DOR-2196, or adding a `Transport` method before a client consumer exists.
- Cache pruning (DOR-2249). This door does not poll. DOR-2196 reads it once on mount, and any polling waits for DOR-2249.
- A cached tree differing from its commit key (DOR-2248).
- Changing the per-package route's response shape.

## Technical Dependencies

- No new packages. `semver`, `zod` and `@asteasolutions/zod-to-openapi` are already used here.
- It relies on `MarketplaceCache.materializePackage`'s in-flight dedupe and atomic rename (`marketplace-cache.ts:216-302`), so concurrent checks that stage the same `<name>@<sha>` share one clone. **Overlap note for DOR-2248:** that item changes the cache and fetcher. The concurrency this spec adds depends on that dedupe surviving.

## Detailed Design

### 1. One scan (`services/marketplace/installed-scanner.ts`)

The scanner already reads each install's identity (`readInstalledIdentity`) and sidecar (`readInstallMetadata`). It keeps both instead of discarding them:

```ts
/** One installation as one scan found it: the listing's view plus what the update check needs. */
export interface InstallationRecord {
  /** Exactly what `GET /api/marketplace/installed` returns for this installation. */
  package: InstalledPackage;
  /** The install root it was found in (`plugins` | `agents` | `shapes`). */
  kind: InstallRootDir;
  /** From `readDeclaredVersion`; `undefined` when the package states none. */
  declaredVersion?: string;
  /** The `.dork/install-metadata.json` sidecar, or `null` when there is none. */
  metadata: InstallMetadata | null;
}

/** Which installations are in view: one project's merged view, or every scope. */
export type InstallationView = { projectPath: string } | { agents: AgentScopeRef[] };

export async function scanInstallationRecords(
  dorkHome: string,
  view: InstallationView
): Promise<InstallationRecord[]>;
```

- `{ agents }` is today's `scanInstallationsAcrossScopes`: the global roots, then each agent's project, one entry per installation, with agent identity. `{ agents: [] }` is the global-only listing.
- `{ projectPath }` is today's `scanInstalledPackages(dorkHome, projectPath)`: the global roots merged with that project's, where a project install shadows a global one in the same root (`override`), and the project's entries carry `agentPath: projectPath`.
- `scanInstalledPackages`, `scanInstallationsAcrossScopes` and `scanAgentLocalInstalls` become `.map((r) => r.package)` over the same record walk. Their output is unchanged, and their existing tests pin it.
- No extra I/O: the sidecar was already read for `installedFrom`, `installedAt` and `dependencyWarnings`.

### 2. The update flow (`services/marketplace/flows/update.ts`)

**The private walker is deleted.** `listInstalled` and `readDirSafe` go. Both doors check `InstallationRecord`s.

```ts
/** One installation's check, with its identity and, after an apply, its outcome. */
export interface InstallationUpdateCheck extends UpdateCheckResult {
  installPath: string; // the join key: GET /installed rows and the Installed view key on it
  type: PackageType;
  scope: PackageScope; // 'global' | 'agent-local' | 'override'
  agentPath?: string; // the project directory for any non-global installation
  agentId?: string;
  agentName?: string;
  /** Set when an apply reinstalled this installation. */
  applied?: InstallResult;
  /** Set when an apply tried to reinstall this installation and failed; says why. */
  applyError?: string;
}

export interface InstallationUpdatesRequest {
  /** The installations to check, from one `scanInstallationRecords` call. */
  installations: InstallationRecord[];
  /** Reinstall every `update-available` installation (default: advisory only). */
  apply?: boolean;
}

export interface InstallationUpdatesResult {
  /** One per installation, in the order they were given. */
  checks: InstallationUpdateCheck[];
}

/** How many installations are checked at once. */
export const UPDATE_CHECK_CONCURRENCY = 4;

export class UpdateFlow {
  /** The per-package door. `name` is now required. */
  run(req: UpdateRequest): Promise<UpdateResult>;
  /** The all-packages door. */
  checkInstallations(req: InstallationUpdatesRequest): Promise<InstallationUpdatesResult>;
  clearMemos(): void;
}

/** Narrow scanned records to the named packages, by the name the update check uses. */
export function selectInstallations(
  records: InstallationRecord[],
  names?: string[]
): InstallationRecord[]; // throws PackageNotInstalledForUpdateError naming every unmatched name
```

- **A check reads its record.** `checkRecord(record)` is today's `checkOne`, fed from the record. The name is `updateNameOf(record.package.name, record.package.installPath)`. The installed side comes from `record.declaredVersion` plus `record.metadata`. Target finding, `resolveLatest` and `compareVersions` are unchanged.
- **`checkInstallations`, advisory.** Records are checked through `mapWithConcurrency(records, UPDATE_CHECK_CONCURRENCY, …)`, and results come back in input order. Each result is the check plus the record's identity (`installPath`, `type`, `scope ?? 'global'`, `agentPath`, `agentId`, `agentName`). Nothing is dropped: an installation that cannot be checked is `unknown` with its note, exactly as before.
- **`checkInstallations`, apply.** After every check settles, each `update-available` installation that has a reinstall request is applied **one at a time, in order**, as `installer.update({ ...request, projectPath: record.package.agentPath })`. A global installation has no `agentPath`, so it is reinstalled globally. A failure is logged and recorded on that installation as `applyError: err.message`; the rest continue. The memos are cleared in a `finally`, as today.
- **Apply scope in `run` (the fix).** `run` scans `{ projectPath }` (or `{ agents: [] }` without one). Among records with the requested name, it prefers a project-scoped one (the project shadows the global package for that project, as the old walk's project-first order did), else the first. It applies with `projectPath: match.package.agentPath`, never `req.projectPath`. A single-package apply still throws, so the route's error mapping (409, 400, …) is unchanged.
- **`selectInstallations`.** With no `names`, or an empty list, it returns the records unchanged. Otherwise it keeps records whose update name is in `names`. If any name matches no record, it throws `PackageNotInstalledForUpdateError` for every unmatched name, and nothing runs.
- **`PackageNotInstalledForUpdateError`** takes one name or several: `packageNames: string[]`, and the message is `Package not installed: a` or `Packages not installed: a, b`. The per-package route's use is unchanged.
- **`mapWithConcurrency` moves** from `services/session/agent-session-fanout.ts` (private) to `@dorkos/shared/map-with-concurrency` (exported, TSDoc, its own test), and the fan-out imports it. One helper instead of two. (Decided during execution: `apps/server/src/lib` is at the 25-file directory limit the pre-commit `dir-size` gate enforces, and a pure, browser-safe pool belongs beside the other shared helpers anyway.)

### 3. The routes (`routes/marketplace.ts`)

```
GET  /api/marketplace/updates[?projectPath=<path>]   → 200 { checks: InstallationUpdateCheck[] }
POST /api/marketplace/updates                        → 200 { checks: InstallationUpdateCheck[] }
     body: { apply: true, names?: string[] (min 1, each min 1), projectPath?: string }
```

**GET (advisory, a read, not gated):**

1. Confine `projectPath` to the boundary (403 `Access denied: projectPath outside boundary`). Use the canonical path it returns.
2. `records = scanInstallationRecords(dorkHome, projectPath ? { projectPath } : { agents: listAgentScopes?.() ?? [] })`. This is the only scan.
3. `res.json(await updateFlow.checkInstallations({ installations: records }))`.

**POST (apply):**

1. The body must parse. `apply` must be the literal `true`, so an empty or advisory POST is a 400 and never reinstalls anything.
2. Confine `projectPath` as above.
3. One scan, as above. `candidates = selectInstallations(records, names)`: an unmatched name is a 404 before any gate or network call.
4. **Authorize before any network work.** For each distinct (update name, `agentPath`) among the candidates, call `authorize(req, res, 'marketplace.install', { name, ...(projectPath && { projectPath }) })`. That is the per-package route's input shape, with the caller's own spelling of the path (see 6). Stop at the first decision that is not `allowed`:
   - `denied` → the gate's 403, as every mutation route answers.
   - `approval_required` → a 403 `{ error, code: 'batch_update_needs_approval' }`. The error says that updating several packages at once cannot wait for a person's approval, and to update them one at a time with `POST /api/marketplace/packages/:name/update`. A batch cannot carry one approval token per package, and a 202 would send the caller round a loop. Unreachable while `marketplace.install` is `act` (which never asks). It is correct if the tier is ever raised.
5. `result = await updateFlow.checkInstallations({ installations: candidates, apply: true })`.
6. For each check with `applied`, fire `onPluginsChanged({ projectPath, packageName: applied.packageName, action: 'install' })`. Here `projectPath` is `undefined` for a global installation, the caller's own spelling when the installation is the requested project's, and the registry's `agentPath` for an agent scope. That matches the per-package route's rule: the notification and the gate carry the caller's spelling, and only the effect uses the canonical path. A check with `applyError` fires nothing.
7. `res.json(result)`. The status is 200 even when some reinstalls failed; the per-installation `applyError` says which.

Errors go through `mapErrorToStatus`. `PackageNotInstalledForUpdateError` is already a 404. The per-package route is unchanged, apart from the scope fix inside `run`.

### 4. The wire types

- `@dorkos/shared/marketplace-schemas` mirrors `InstallationUpdateCheck` and `InstallationUpdatesResult` next to `UpdateResult`. The CLI imports these, and the existing `UpdateCheckResult` / `UpdateResult` / `UpdateVersionSource`, instead of its local mirrors, which are deleted.
- `services/core/openapi-registry.ts` documents both paths: `LocalInstallationUpdateCheckSchema = LocalUpdateCheckResultSchema.extend({ … })`. GET: 200, 403. POST: 200, 400, 403, 404. `docs/api/openapi.json` and the generated API pages are regenerated.

### 5. The CLI (`packages/cli/src/commands/update.ts`)

- **A named run** (`dorkos update <name>`) is unchanged: one `POST /packages/:name/update`.
- **A name-less run** is one request:
  - advisory: `GET /api/marketplace/updates[?projectPath=…]`
  - `--apply`: `POST /api/marketplace/updates { apply: true, projectPath? }`
  - An `ApiError` ends the run with exit 1, and the message on stderr. There are no per-target requests left to isolate: the server isolates per installation.
- **Lines.** A non-global installation's label carries its place: `flow [Alpha]  0.7.2 → 0.7.3  (dorkos-community)`. `Alpha` is `agentName` when there is one, else `agentPath`. A global installation's line is unchanged. The same name in two scopes is therefore two distinguishable lines.
- **Applied / failed.** `Applied:` lists every check with `applied` (`  flow [Alpha]@0.7.3 → <installPath>`). `Could not update:` lists every `applyError` (`  flow [Alpha]: <reason>`).
- **Exit codes:** 0 on success; 1 when the server could not be reached, answered an error, or any reinstall failed. A non-zero "stale" exit stays DOR-2193's `outdated`.
- `listTargets`, `couldNotCheck` and the per-target loop are deleted.

### 6. What the three consumers do with it

- **DOR-2195 (MCP).** `marketplace_update { name?, apply? }` scans once, calls `selectInstallations(records, name ? [name] : undefined)`, then `checkInstallations`. It goes through the confirmation provider before an apply, and fires `onPluginsChanged` per `applied`, exactly as the POST route does. `marketplace_list_installed { checkUpdates: true }` scans records once, lists `records.map((r) => r.package)`, and joins `checkInstallations({ installations: records }).checks` by `installPath` to add `latestVersion` / `hasUpdate`. Without `checkUpdates` it never calls the flow, so it makes no network call.
- **DOR-2196 (Installed view).** It reads `GET /updates` once on mount, for the same view `GET /installed` returns (the same `projectPath` or none), and keys each check by `installPath`: the row key the view already uses. The count on the tab is `checks.filter((c) => c.hasUpdate).length`. "Update all" confirms `checks.filter(hasUpdate)` by name and place, then sends `POST /updates { apply: true, names, projectPath }`. The response's `applied` / `applyError` per row is what it reports.
- **DOR-2193 (`marketplace outdated`).** It reads `GET /updates[?projectPath]`, prints `checks.filter((c) => c.status === 'update-available')` as `name  installed -> latest  (marketplace)`, labelled by place as above, and exits non-zero when that list is not empty.

## User Experience

Kai has flow installed globally and on two agents, one of which is behind:

```
$ dorkos update
flow  up to date (0.7.3)
flow [Alpha]  0.7.2 → 0.7.3  (dorkos-community)
flow [Beta]  up to date (0.7.3)
1 update available, 2 up to date. Run again with --apply to install it.

$ dorkos update --apply
flow  up to date (0.7.3)
flow [Alpha]  0.7.2 → 0.7.3  (dorkos-community)
flow [Beta]  up to date (0.7.3)
1 update available, 2 up to date.

Applied:
  flow [Alpha]@0.7.3 → /work/alpha/.dork/plugins/flow
```

`dorkos update --apply --project .` updates what this project sees. A package installed globally is updated where it is, globally. It is never moved into the project.

## Testing Strategy

Each test carries a purpose comment and can fail.

- **Scanner** (`installed-scanner.test.ts`):
  - `scanInstallationRecords` carries `declaredVersion` (including `undefined` for a Claude-Code-only package that declares none) and the sidecar;
  - `{ agents }` yields one record per installation with agent identity;
  - `{ projectPath }` yields the merged view with `override` shadowing;
  - the three list helpers still return what their existing tests pin.
- **`mapWithConcurrency`** (`packages/shared`): results in input order, never more than `width` in flight, and an empty input.
- **`UpdateFlow`** (`flows/update.test.ts`). The name-less `run({})` tests move to `checkInstallations` fed by `scanInstallationRecords`, with the assertions unchanged. New tests:
  - every check carries its installation's identity, and the same name in two scopes is two checks;
  - an agent-scope installation (invisible to the old walk) is checked;
  - the advisory form never calls `installer.update`;
  - apply reinstalls a global installation with no `projectPath` and an agent's with its `agentPath`;
  - one failing reinstall is recorded as `applyError` while the next still lands, and the memo is still cleared;
  - at most `UPDATE_CHECK_CONCURRENCY` checks are in flight, and results keep scan order;
  - concurrent checks of one source share one in-flight `ls-remote`, even though a failed one is never kept;
  - `selectInstallations`: no names or empty names keep all; names narrow; unmatched names throw, naming every one;
  - **`run` applies a global-only package with no `projectPath` even when the request carried one** (fails on `3b36e3876`).
- **Integration** (`integration.test.ts`, real installer, `file://` marketplace):
  - a global install updated through `run({ name, apply, projectPath })` stays global and never appears in the project (the reproduced defect);
  - `checkInstallations` over a global install and an agent-project install of the same package reports two checks, applies both in place, and a rerun reports both current;
  - the advisory form leaves the installed listing identical.
- **Routes** (`routes/__tests__/marketplace.test.ts`, fake flow, real capability registry):
  - GET scans every scope once (a spy on `scanInstallationRecords`) and hands the records to `checkInstallations` with no `apply`;
  - GET `?projectPath` uses the canonical path and the project view; an out-of-boundary path is 403;
  - POST without `apply: true` is 400, and the flow is never called;
  - POST with an unmatched name is 404, and the flow is never called;
  - POST fires `onPluginsChanged` once per applied check, with the right `projectPath` for global, requested-project and agent installations, and none for an `applyError`;
  - an agent caller is allowed (install is `act`);
  - with a registry where `marketplace.install` asks for approval, POST is 403 `batch_update_needs_approval`, and nothing runs;
  - the per-package route's existing tests stay green.
- **OpenAPI** (`export-openapi.test.ts`): both paths are documented, GET as a read with no request body, POST with `apply` required.
- **CLI** (`packages/cli/src/__tests__/update.test.ts`):
  - a name-less run is one GET (with `--project` in the query), and with `--apply` one POST whose body is `{ apply: true, projectPath? }`;
  - scope labels;
  - `Applied:` and `Could not update:` sections;
  - exit 1 on an `applyError` or a server error;
  - a named run still uses the per-package route.
- **Mocking.** The installer, fetcher and source manager are faked on the flow's deps, as today. No test touches the network.

## Performance Considerations

- **Scan:** one local walk per request instead of 2N+1 for a name-less CLI run. It still runs `validatePackage` once per Claude-Code-only install, and only once.
- **Checks:** 4 at a time. An unchanged package costs one `git ls-remote` per repository and ref; a changed one costs one sparse clone into the cache (version-truth spec §Performance). Because the memo stores in-flight promises, concurrent checks of packages from one repository share one index fetch and one `ls-remote`. They also share it when it fails, which a sequential run cannot do, since failures are not memoized.
- **Bounding a slow scope:** the scan is local disk only, so an agent scope costs the time to read its `.dork/{plugins,agents,shapes}`. Its checks' remote work is bounded by the fetcher's own timeouts (`LS_REMOTE_TIMEOUT_MS` = 15s, the clone timeouts). A slow or unreachable repository therefore costs at most those timeouts, inside one of 4 slots, and ends as that installation's `unknown`. The worst case is about ⌈distinct slow repositories ÷ 4⌉ × the timeout, not one timeout per installation.
- **Applies:** sequential. Each takes its install target's lock, and a batch should not multiply git and npm work on a loaded machine.
- **Cache growth** is unchanged per check. This door must not be polled until DOR-2249 gives pruning an owner.

## Security Considerations

- The advisory GET runs no package code. It stages and validates only, as the per-package advisory does, and changes no installed state.
- An apply authorizes every reinstall as `marketplace.install` with the per-package input shape, before any clone. A batch that would need a person's approval is refused outright rather than half-run.
- `projectPath` is confined to the boundary before the scan. `names` are compared against scanned names only; nothing a caller sends is joined into a path (`updateNameOf` already guards the name the installer receives).
- No new data leaves the machine. The response adds `installPath` and `agentPath`, which `GET /installed` already returns to the same callers.

## Documentation

- `contributing/marketplace-installs.md`, update-flow section: the two doors, the one scan, the per-installation result keyed by `installPath`, concurrency and ordering, apply scope and isolation, and batch authorization.
- `docs/marketplace/index.mdx` and `docs/guides/cli-usage.mdx`: the place label on non-global lines, and that `--apply --project` updates a globally installed package where it is.
- `docs/api/openapi.json` plus the generated API pages.
- A changelog fragment in plain words.
- A draft ADR: an update check or apply is per installation, and an apply reinstalls in the installation's own scope.

## Implementation Phases

- **Phase 1:** the scanner records, `mapWithConcurrency`, and `UpdateFlow` (`checkInstallations`, `selectInstallations`, and the scope fix in `run`), with tests.
- **Phase 2:** the routes, the OpenAPI docs and the shared types, with tests.
- **Phase 3:** the CLI on the new door, the docs, the changelog, and the ADR.

All three ship in one PR, with this spec.

## Open Questions

1. ~~Should POST also accept an advisory form (`apply: false`)?~~ (RESOLVED)
   **Answer:** No. GET is the read. POST requires `apply: true`.
   **Rationale:** An empty or mistyped POST must never be the request that reinstalls everything, and two ways to read one thing is one too many.
2. ~~Should the per-package route also stop scanning twice?~~ (RESOLVED)
   **Answer:** Not in this item. It is a single-package door, whose extra scan is one local walk. Its 404-vs-scoped-`unknown` contract stays exactly as it is, and only its apply scope is fixed.
   **Rationale:** The cost the review named was the N× loop, which the CLI no longer makes.
3. ~~Should the Installed view's per-row Update move onto `POST /updates { names: [name], projectPath }`?~~ (RESOLVED)
   **Answer:** That is DOR-2196's call. Both doors now reinstall in the installation's own scope, so either is correct.

## Related ADRs

- ADR-0233: update is advisory by default, and an applied update authorizes as `marketplace.install`. Unchanged; applied per installation here.
- ADR-0310: runtime-owned sessions with an aggregated listing and per-source degradation. This door follows the same "one entry per item, nothing dropped, a reason on each" shape.
- ADR 260923-122615: a package's latest version is what an install would resolve. The check logic is reused unchanged.
- **New (draft):** ADR 260923-163034, an update is checked and applied per installation, in the installation's own scope (`decisions/260923-163034-updates-are-per-installation-in-their-own-scope.md`).

## References

- DOR-2194 (this item). Consumers: DOR-2193, DOR-2195, DOR-2196. Related: DOR-2244 (version truth, merged), DOR-2248 (cache/fetcher, in flight), DOR-2249 (cache pruning).
- `specs/marketplace-version-truth/02-specification.md` §6–7, §Performance.
