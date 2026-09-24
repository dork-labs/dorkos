# Marketplace Installs

The install machinery for the DorkOS Marketplace — how `dorkos install` turns a package name into files on disk, how rollback works when something breaks, and how to add a new install flow without violating the contract every other flow relies on.

**See also:** [`contributing/external-agent-marketplace-access.md`](external-agent-marketplace-access.md) — how external AI agents (Claude Code, Cursor, Codex) connect to the DorkOS marketplace MCP server and drive the install flow remotely.

Pair this guide with:

- [`specs/marketplace-02-install/02-specification.md`](../specs/marketplace-02-install/02-specification.md) — the authoritative spec. If this guide and the spec disagree, the spec wins and this file needs a patch.
- [`contributing/architecture.md`](architecture.md) — the broader DorkOS hexagonal architecture.
- [ADR-0304](../decisions/0304-file-scoped-rollback-for-marketplace-installs.md): why every flow runs through the file-scoped `runTransaction` (supersedes ADR-0231's git backup-branch rollback).
- [ADR-0232](../decisions/0232-content-addressable-marketplace-cache-with-ttl.md) — why `marketplace.json` has a TTL and cloned packages do not.
- [ADR-0233](../decisions/0233-marketplace-update-is-advisory-by-default.md) — why `dorkos update` never mutates disk without `--apply`.
- [ADR-0305](../decisions/0305-per-cwd-plugin-activation-for-project-scoped-installs.md): the original per-cwd SDK activation for scoped installs; its mechanism is superseded by harness projection ([ADR 260706-192819](../decisions/260706-192819-harness-native-plugin-delivery.md), see section 16).
- [ADR-0306](../decisions/0306-one-entry-per-installation-cross-scope-installed-api.md) — why the installed API returns one entry per installation across scopes (see section 16).

## 1. Overview

A marketplace install turns a short identifier (`code-review-suite@dorkos-community`) into a working installation on disk. The pipeline is deterministic, atomic, and observable: the same seven steps run for every package type, and any failure along the way leaves zero residue.

The five supported package types are `plugin`, `agent`, `skill-pack`, `adapter`, and `shape`. Each has its own destination rules and activation hook, but they all share the same orchestrator, the same transaction engine, the same permission preview, the same conflict detector, and the same cache layer. If you want to add a sixth type, you write one flow file and plug it into the dispatch switch — everything else is already wired (see section 9).

Marketplace browsing and installation are implemented in the app, and the website has a separate discovery surface. This guide covers the local operational core; see [the system map](system-architecture.md#marketplace-discovery-and-delivery) for how the pieces connect.

### Key invariants

1. **Nothing touches disk before the permission preview is built.** The user always sees what will change before it changes.
2. **Every flow runs through `runTransaction`.** Failures clean up the staging directory unconditionally. When the install target already exists, it is moved aside to a sibling backup before activation and restored if activation fails, so a failed reinstall never leaves a half-overwritten directory.
3. **Activation is a single mutating operation per flow** — typically an atomic `fs.rename` via the `atomicMove` helper. Anything that can't be expressed as one atomic move either uses compensating actions (adapters) or lives in a follow-up step that is itself idempotent (extension enable, agent scaffolding).
4. **The orchestrator performs no I/O of its own.** Every collaborator is injected, which keeps `MarketplaceInstaller` unit-testable without touching the network or the filesystem.
5. **One telemetry event per terminal state.** Success, validation failure, conflict gate, and flow failure all emit exactly one `reportInstallEvent` call.

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                       dorkos install CLI                          │
└──────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                  POST /api/marketplace/install                    │
└──────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                       MarketplaceInstaller                        │
│   1. Resolve package source (marketplace name → git URL)          │
│   2. Cache check / clone via template-downloader                  │
│   3. Validate package via @dorkos/marketplace/package-validator   │
│   4. Build PermissionPreview                                      │
│   5. Confirm with user (CLI) / return preview (HTTP)              │
│   6. Stage installation in temp directory                         │
│   7. Detect conflicts                                             │
│   8. Activate (atomic rename, register, notify)                   │
│   9. Cleanup or rollback                                          │
└──────────────────────────────────────────────────────────────────┘
                │              │              │              │
                ▼              ▼              ▼              ▼
        PluginFlow      AgentFlow      SkillPackFlow    AdapterFlow
                │              │              │              │
                └──────────┬───┴──────────────┴──────────────┘
                           ▼
              ┌──────────────────────┐
              │  Existing Services    │
              │  (extension-manager,  │
              │   task-reconciler,    │
              │   adapter-manager,    │
              │   mesh-core)          │
              └──────────────────────┘
```

The CLI is a thin HTTP client — every install path funnels through the same HTTP route into the same `MarketplaceInstaller` instance. There is no second implementation for the CLI. This keeps the behaviour identical whether the user is typing commands into a terminal or clicking through the marketplace extension UI.

## 3. Service module layout

All marketplace install code lives under `apps/server/src/services/marketplace/`:

```
apps/server/src/services/marketplace/
├── marketplace-installer.ts     # Top-level orchestrator + error classes
├── marketplace-source-manager.ts # ~/.dork/marketplaces.json CRUD
├── marketplace-cache.ts         # ~/.dork/cache/marketplace/ with TTL; stamps use, removeUnused
├── package-cache-retention.ts   # What the package cache keeps; sweeps after each new entry
├── package-resolver.ts          # name@source → resolved source descriptor
├── package-fetcher.ts           # Verified git fetch through the cache + marketplace.json fetch
├── permission-preview.ts        # Build human-readable preview
├── conflict-detector.ts         # Detect slot/skill/task/cron/adapter collisions
├── transaction.ts               # Stage → activate → cleanup/rollback engine
├── telemetry-hook.ts            # Singleton reporter for InstallEvent
├── types.ts                     # Shared types (InstallRequest, PermissionPreview, ...)
├── source-resolvers/
│   ├── git.ts                   # github, url and git-subdir: one fetch
│   ├── relative-path.ts         # A path inside a local marketplace
│   └── npm.ts                   # Not supported yet (throws)
├── lib/
│   ├── atomic-move.ts           # Cross-device-safe fs.rename replacement
│   ├── git-tree.ts              # Resolve a ref exactly; fetch one commit, verify HEAD
│   └── npm-dependencies.ts      # Staged `npm install` + the preview's reader
├── flows/
│   ├── install-plugin.ts
│   ├── install-agent.ts
│   ├── install-skill-pack.ts
│   ├── install-adapter.ts
│   ├── uninstall.ts
│   └── update.ts
├── __tests__/
│   ├── marketplace-installer.test.ts
│   ├── marketplace-source-manager.test.ts
│   ├── marketplace-cache.test.ts
│   ├── package-cache-retention.test.ts
│   ├── package-resolver.test.ts
│   ├── permission-preview.test.ts
│   ├── conflict-detector.test.ts
│   ├── transaction.test.ts
│   ├── integration.test.ts
│   ├── failure-paths.test.ts
│   └── flows/*.test.ts
└── fixtures/
    └── (sample packages used by integration tests)
```

The HTTP surface lives at `apps/server/src/routes/marketplace.ts`. The CLI subcommands live at `packages/cli/src/commands/{install,uninstall,update,marketplace-*,cache-*}.ts`.

## 4. The install flows

Every flow implements the same `install(packagePath, manifest, opts)` method and wraps its work inside `runTransaction`, passing the install `target` so the engine can back it up and restore it on failure. They differ only in destination rules and what gets compiled or registered during activation.

### Plugin flow (`flows/install-plugin.ts`)

Destination: `${dorkHome}/plugins/<name>/` (global) or `${projectPath}/.dork/plugins/<name>/` (project-local).

1. **Stage** — Copy the package contents into the staging directory. Walk `.dork/extensions/*/extension.json` and compile each extension via `ExtensionCompiler.compile()`. Any compile failure throws, which drops the staging dir before `activate` runs.
2. **Activate** — `atomicMove(stagingDir, installRoot)`. Re-walk the installed extensions and call `extensionManager.enable(id)` for each. Tasks and skills are picked up automatically by `task-file-watcher` and Claude Code respectively — there is no explicit registration step.

Passes `target: installRoot`. If `enable` throws after the move lands, the engine removes the partial target and restores the previous installation.

For a **project-scoped** plugin, a follow-up step projects its commands, skills, and hooks to every harness the project uses (including Claude Code) as native files, so the external `claude` CLI and DorkOS sessions see the same plugin. That is the Harness Sync engine's job, not the transaction's: see [harness-sync.md](harness-sync.md) §4 and [ADR 260706-192819](../decisions/260706-192819-harness-native-plugin-delivery.md). It runs via GAP-4 auto-projection (`services/harness/auto-project.ts`) after every successful install, uninstall and applied update, whichever surface drove it: the HTTP routes (`routes/marketplace.ts`) and the `marketplace_install` / `marketplace_uninstall` / `marketplace_update` MCP tools (`services/marketplace-mcp/tool-{install,uninstall,update}.ts`). Both receive the same `onPluginsChanged` notifier, built once in `apps/server/src/index.ts`, which also refreshes the Claude runtime's plugin list for that cwd. It is a required dependency on both `MarketplaceRouteDeps` and `MarketplaceMcpDeps`, so a new surface that mutates installs cannot be wired without it. It fires only after the mutation succeeds (never on a pending confirmation, a decline or an error), with `{ projectPath, packageName, action }`, where `packageName` is the resolved manifest name and `projectPath` is the caller's own spelling rather than the canonical path the mutation used, because listeners match it against project paths spelled the way the person picked them (DOR-711); both surfaces send the same spelling. It is fire-and-forget: the notifier built in `index.ts` catches its own failures, and each surface also logs a notifier that throws and still reports the mutation as succeeded (DOR-2057).

### Agent flow (`flows/install-agent.ts`)

Destination: `${dorkHome}/agents/<name>/` (global) or `${projectPath}` used directly (project-local).

1. **Stage** — Copy the package contents (template files) into the staging directory. Apply `manifest.agentDefaults` if present.
2. **Activate** — `atomicMove(stagingDir, targetDir)`. Delegate to the existing `createAgentWorkspace()` pipeline with `skipTemplateDownload: true` to scaffold `.dork/agent.json`, `SOUL.md`, and `NOPE.md`. Mesh registration happens implicitly via the mesh-core reconciler — this flow never registers directly.

Passes `target: targetDir`. A failed scaffold restores the previous agent directory (or removes the partial one on a fresh install).

### Skill-pack flow (`flows/install-skill-pack.ts`)

Destination: same as plugin — `${dorkHome}/plugins/<name>/` or `${projectPath}/.dork/plugins/<name>/`.

1. **Stage** — Copy the package contents. Re-validate every `SKILL.md` via `@dorkos/skills` (the package validator already ran upstream, but the re-verification catches any mid-install corruption).
2. **Activate** — `atomicMove(stagingDir, installRoot)`. Skills are picked up by Claude Code on next discovery; tasks by `task-file-watcher`. No explicit registration.

Passes `target: installRoot`. A reinstall over an existing pack restores the prior version if activation fails.

### Adapter flow (`flows/install-adapter.ts`)

Destination: `${dorkHome}/plugins/<name>/` (global only — adapters are never project-local in v1, because the relay's `relay-adapters.json` registry has no per-project dimension). A request that carries a `projectPath` still installs globally, but the result's `warnings` carries `ADAPTER_PROJECT_PATH_IGNORED_WARNING` so the caller's scope choice is not silently discarded (DOR-1776) — the same contract the Shape flow's `SHAPE_PROJECT_PATH_IGNORED_WARNING` has (DOR-386). A global-only flow must warn, never ignore in silence.

1. **Stage** — Copy the package contents into the staging directory.
2. **Activate** — `atomicMove(stagingDir, installPath)`. Call `adapterManager.addAdapter({...})` with the new entry. If registration throws, run a compensating `removeAdapter` call.

Passes `target: installPath`. The engine restores the previous package contents if activation fails; the `relay-adapters.json` mutation is undone separately by the compensating `removeAdapter` call, because a filesystem restore cannot reach the adapter config file.

### Uninstall flow (`flows/uninstall.ts`)

Removes a previously installed package by name. Plugin/skill-pack/adapter packages live under `plugins/<name>/`; agent packages under `agents/<name>/`; shape packages under `shapes/<name>/` — under either scope root, the global `${dorkHome}` or a project's own `${projectPath}/.dork`. The probe walks the project's roots first (a project install shadows a same-named global one), then the global roots, and both halves come from `installRootsUnder()` so the probe can never miss a root an install flow writes to. Probing the project scope for `plugins/` alone is what left every project-scoped agent installable but not removable (DOR-994).

The flow is rollback-safe without git: the package is moved to a temporary staging directory first, side-effects (extension disable, adapter removal) run against the now-empty location, and only after every step succeeds is the staging directory permanently removed. Any thrown error during the side-effect phase restores the package from staging back to its original install path via `atomicMove`.

**Data preservation.** When `purge: false` (the default), the contents of `<installRoot>/.dork/data/` and `<installRoot>/.dork/secrets.json` are preserved across uninstall + reinstall. With `purge: true`, both paths are removed along with everything else. This is the behaviour that makes the update flow safe (see below).

### Update flow (`flows/update.ts`)

Advisory by default. See [ADR-0233](../decisions/0233-marketplace-update-is-advisory-by-default.md) for the full rationale.

The question it answers is "what would installing this package right now give me?", read by Claude Code's own version rule ([ADR 260923-122615](../decisions/260923-122615-package-version-resolved-like-an-install.md)). A package's version is, in order: the `version` it declares (`plugin.json`, else `.dork/manifest.json`, via `readDeclaredVersion`), else its marketplace entry's `version`, else the commit it was fetched at (`resolvePackageVersion` in `@dorkos/marketplace`). Our own marketplace sets no entry `version`, so the entry step is for third-party marketplaces.

1. **Take the installations from one scan.** The flow does not walk install roots itself. It checks `InstallationRecord`s from the installed scanner's `scanInstallationRecords(dorkHome, view)`, the same walk the Installed list is a view of. The view is `{ agents }` (every scope: global, then each registered agent's project, one record per installation) or `{ projectPath }` (that project's merged view, where a project install shadows a global one in the same root). Each record carries the listing's `InstalledPackage`, the install root it was found in, the declared version (`readDeclaredVersion`), and the `.dork/install-metadata.json` sidecar with `commitSha`, `entryVersion` and `sourceKey`. The identity read never gates on validity, so Claude-Code-only installs and installs whose version files disagree are checked too.
2. **Find where it would be reinstalled from.** A direct install (`name@url`, `github:`; no `installedFrom`) is checked against its own recorded source. Anything else searches marketplaces: `installedFrom` first if enabled, then every enabled source. The MATCHED source's name is what the installer receives, never `installedFrom` blindly.
3. **Ask the installer** (`MarketplaceInstaller.resolveLatest`). It reuses the install pipeline (resolve → stage into the SHA-keyed cache → `validatePackage`), with one short-circuit: when **all three** of these equal what the install recorded, the package is `unchanged` and nothing is staged or cloned:
   - the same `sourceKey` (clone URL, subpath, effective ref, normalized by `sourceKeyOf`);
   - the same marketplace entry `version` (both absent counts as the same);
   - the same commit, from a memoized `git ls-remote` of the key's ref. A ref that is already a full 40-hex SHA is its own commit, with no `ls-remote`.

   A sidecar with no `sourceKey` (written before it existed) never short-circuits. A staged version that fails validation (`VERSION_MISMATCH` included) is `unresolved`: a version DorkOS would refuse to install is never offered. `resolveLatest` never throws; any error, a refused address included, becomes `unresolved` with its message.

4. **Compare** and return one check per package with a `status`:
   - `update-available` when both sides are semver and the latest is strictly newer, or when they differ and either side is a commit or not semver;
   - `current` when equal, or when the marketplace is on an older version (with a `rollback` note: a downgrade is never offered as an update);
   - `unknown`, with a `note` saying why: the source could not be reached, no enabled marketplace lists the package, the new version can't be installed, the install records no version at all, or a named package is not installed in this scope.

   Nothing is dropped, and an `unknown` check is never reported as current. `hasUpdate` is kept and always equals `status === 'update-available'`.

5. **If and only if `apply: true` was set**, reinstall every `update-available` installation through the injected `InstallerLike.update()`, **in the scope the installation was found in**: its project for a project or agent install, none for a global one ([ADR 260923-163034](../decisions/260923-163034-updates-are-per-installation-in-their-own-scope.md)). It also passes the exact install root the check resolved (`InstallRequest.installRoot`), which `update()` and the uninstall flow use to narrow their by-name probe, so a plugin and an agent sharing a name never have the wrong one replaced. It never uses the scope the request named, because the installer uninstalls by probing project roots then global ones, and reinstalls into whatever `projectPath` it is given. Before DOR-2194 an apply passed the request's `projectPath`, so updating a global package with `--project` deleted the global install and reinstalled it into the project. The installer handles uninstall-without-purge → reinstall, which preserves `.dork/data/` and `.dork/secrets.json` across versions, and runs the full install pipeline, validation included. It installs with `force: true`, so conflicts are detected but do not block the reinstall. An apply never runs on `unknown` or `current`.

**Two doors.**

- `UpdateFlow.run({ name, installation, apply? })` is the per-package route's (`POST /packages/:name/update`). The route scans the global scope plus the project's merged view and resolves the installation with `pickInstallation` (the project's own first), so it can authorize and notify with the scope the reinstall actually touches — none for a global installation. `run` returns `{ checks, applied }`. A name missing from its scope is one `unknown` check ("not installed in this scope"). The route answers 404 for a name installed in no scope at all, since it can see every scope and the flow cannot. A failed reinstall throws, so the route maps it to a status.
- `UpdateFlow.checkInstallations({ installations, apply? })` is the all-packages door's (`GET` / `POST /updates`). The caller scans once and hands the records in. That is why `marketplace_list_installed { checkUpdates }` (DOR-2195) can list and check from one walk. It returns `{ checks: InstallationUpdateCheck[] }`: one entry per installation, in scan order, each with the installation's identity in the installed list's own field names (`installPath`, `type`, `scope`, `agentPath`, `agentId`, `agentName`). `installPath` is the join key, the same one the Installed view keys rows on. After an apply, an entry carries `applied` (the `InstallResult`) or `applyError` (why it failed). `selectInstallations(records, { names, installPaths })` narrows a scan: `names` to every installation of those packages, `installPaths` to exactly the installations a check reported (what a confirm step showed). Any unmatched name or path throws `PackageNotInstalledForUpdateError`, whose 404 body carries `packageNames` and `installPaths`, before anything runs. A symlinked install (a working copy linked into place; the record's `linked`) is checked as `unknown` with "linked install — update its source instead" and never reinstalled.

The door's orchestration lives in `flows/update-installed.ts` so the HTTP route and the MCP tools share it: `scanUpdateView`, `callerSpelling`, `checkInstalledUpdates(deps, projectPath, selector?)`, `reinstallsOf`, and `applyInstalledUpdates(deps, request, gate)`, where only the permission step (a `ReinstallGate`) is surface-specific. The gate is called ONCE, with every distinct reinstall (`reinstallsOf`: one per update name and scope, in scan order, a linked install left out because it is never reinstalled), and may answer asynchronously; when nothing could be reinstalled it is not called at all. The HTTP route loops the tier gate over them; the `marketplace_update` MCP tool asks one confirmation for the whole set. `GET /installed?projectPath` scans at the same canonical path, so its rows and these checks join on `installPath` even through a symlinked project.

**Cost and ordering.** Every check, from either door and any number of concurrent requests, takes a slot from one FIFO semaphore on the `UpdateFlow` instance: at most `UPDATE_CHECK_CONCURRENCY` (4) run at once across the whole server. Results come back in scan order. A check that throws becomes that installation's `unknown` ("couldn't check this package: …") and releases its slot, so it can neither fail the request nor stall the queue. Each check's remote work is bounded by the fetcher's own timeouts (`ls-remote`, clone). A slow or unreachable repository holds only its own slot and ends as that installation's `unknown`, so a slow agent scope never blocks the rest. Because the memo stores in-flight promises, concurrent checks of one repository share one index fetch and one `ls-remote`, including a failing one, which a sequential run would repeat. Concurrent staging of the same `<name>@<sha>` is safe because `MarketplaceCache.materializePackage` dedupes in-flight clones and renames atomically; keep that true when changing the cache. Applies run one at a time, in order. A failed reinstall is recorded on its installation, the rest carry on, and the memos are cleared at the end either way.

**Authorizing a batch.** When `marketplace.install`'s tier could ask a person (above `act`) and the caller is not trusted, the batch is refused with a 403 `batch_update_needs_approval` before any gate call, so no approval request nobody could redeem is raised. Otherwise `POST /updates` authorizes every reinstall as `marketplace.install`, with the per-package route's input shape (`{ name, projectPath? }`, the caller's own spelling for the requested project), before any network work. It stops at the first refusal, with nothing run. A batch cannot carry one approval token per package, which is why the approval case is refused up front. The route then fires `onPluginsChanged` once per `applied`, with that installation's project (none for a global one).

**The MCP tool (`marketplace_update`, DOR-2195).** Advisory by default: `checkInstalledUpdates` with the same `names` / `installPaths` selection, answered as `{ status: 'checked', checks }`, with no confirmation and no reinstall. With `apply: true` it goes through `applyApprovedUpdates`, not the route's door, because it asks a person and a person must see what they approve. It checks first (`UpdateFlow.planInstallations({ disclose: true })`), which also stages every `update-available` installation's new version through `installer.preview` and records `disclosedEffectsOf` it on the check (`disclosed`: hooks, scheduled jobs, MCP and language servers, monitors, `bin/` commands). A new version that cannot be read, or that declares anything the preview could not read (`unreadableHooks`, `unreadableDeclarations`), becomes `unknown` with the paths in its note and can never be approved from the card. The confirmation provider then asks once, as operation `update` (capability `marketplace.update`, tier `act`), about exactly the stale installations: the card's `detail` lists each one's name, type, place, old and new version, and everything its new version runs, written out whole with hidden and direction-changing characters shown (`revealHiddenCharacters`). A plugin's own programs are said to start "in every session" only for a global installation; a project's copy says they are not started, because project installs are projected as files and those programs are not among them. A list longer than `APPROVAL_DETAIL_MAX_LENGTH` is refused with a plain message, never cut. The approval binds the set of `{ installPath, latestVersion, disclosed }` (sorted), so it cannot stretch over another installation of the same name, a newer version, or a version that runs something else; the retry recomputes everything and re-asks with a reason if it moved. After a yes, `UpdateFlow.applyPlan(plan, approved)` reinstalls only the approved installations, each with `InstallRequest.approvedDisclosure`. `MarketplaceInstaller.update()` resolves and stages the new version once, BEFORE it uninstalls anything, checks the approved disclosure against that stage, and then installs exactly that stage, so a commit that lands after the yes is refused for that installation (`applyError`) and the old version stays in place. When nothing could be applied the tool answers `nothing-to-update`. A `preApproved` caller (a spent tier-gate approval, or a trusted caller) is not asked again. `marketplace_list_installed { checkUpdates: true }` adds an `update` summary (`status`, `latestVersion`, `hasUpdate`, `note`) to each entry from the same one scan; without `checkUpdates` it never calls the flow, so it makes no network call. The HTTP `POST /updates` still binds nothing; that gap is tracked separately.

**What the preview reads (`lib/package-hooks.ts`, `lib/package-programs.ts`).** Everything a Claude Code plugin runs on its own, from its default files and from `.claude-plugin/plugin.json` (a path, an inline value, or a list of either): hooks (`hooks/hooks.json`, `hooks`), MCP servers (`.mcp.json`, `mcpServers`), language servers (`.lsp.json`, `lspServers`), monitors (`monitors/monitors.json`, `experimental.monitors`), and the files in `bin/`. A hook of a type other than `command` is reported unreadable rather than dropped. Skills and commands (`skills/**/SKILL.md`, a root `SKILL.md`, plugin.json `skills`, and `commands/**/*.md` or what plugin.json `commands` replaces it with) are read for their frontmatter `hooks`, which Claude Code registers while the skill is in use, each tagged with its `source`, and for `allowed-tools` (`skillTools`), because the model picks a skill by its description (`lib/package-skills.ts`). Frontmatter is parsed as YAML or JSON only: `---js` would be evaluated by gray-matter, so it is refused and reported unreadable (the repo-wide fix is DOR-2308). Every declaration is read through `readDeclarationJson` (`lib/package-declarations.ts`): a path out of the package, a symbolic link, or a file whose real location is outside the package's real root is reported unreadable and never opened, so the preview cannot leak a file such as `~/.claude.json` to the agent or client that asked. Agents are not disclosed: Claude Code ignores `hooks`, `mcpServers` and `permissionMode` in a plugin agent. Workflows run only when invoked by name. An output style marked `force-for-plugin` changes every session's instructions; it is not a program and is a known leftover.

**Memos.** `UpdateFlow` is one instance per server and holds two memos for 60 seconds (`UPDATE_MEMO_TTL_MS`): the commit lookup per (clone URL, ref) and the marketplace index per source. A named `dorkos update <name>` and the app's per-row Update send one request per package, so a per-request memo would never span them. Each stores the in-flight promise, so concurrent checks share one lookup, and a failure or placeholder commit is dropped as soon as it settles. Both are cleared after every apply and by `POST /sources/:name/refresh` (`dorkos marketplace refresh`). The honest claim is "shared within one CLI run or UI burst": without a refresh, a push from the last minute can still read as current.

**Known limits.**

- Each check that observes a new marketplace commit stages one cache entry per installed package from that repository. The cache's retention owner (section 8) removes the superseded ones after the check, so this no longer accumulates.
- A direct install (`name@url`, `github:`) is always fetched from the default branch today: neither form can carry a ref or subpath, so its recorded `sourceKey` is always `ref: 'HEAD'` (`'main'` in sidecars written before DOR-2248, which `resolvedFromSourceKey` reads as `HEAD` and `matchesRecordedKey` accepts against `HEAD`), `subpath: ''`, and applying an update reinstalls from the same place. If install requests gain a structured source, apply must carry the recorded key too. A direct install recorded before `sourceKey` existed is checked against the default branch, and its check says so in `note`.

The update flow never changes an installed package on its own. Anything that mutates installed state lives inside the installer's transaction. A check may stage a new version into the package cache, as the per-package advisory always has.

## 5. Transaction lifecycle

One primitive, one file: `services/marketplace/transaction.ts`. Every install flow (and the update-apply path, which delegates to the installer) runs through it; the uninstall flow uses its own staging + restore path. The engine is file-scoped and git-free (see [ADR-0304](../decisions/0304-file-scoped-rollback-for-marketplace-installs.md), which supersedes ADR-0231's git backup-branch rollback).

```typescript
runTransaction<T>(opts: {
  name: string;
  target: string;
  stage: (staging: { path: string }) => Promise<void>;
  activate: (staging: { path: string }) => Promise<T>;
}): Promise<T>;
```

`target` is the absolute install location the flow's `activate` renames onto (e.g. `<projectPath>/.dork/plugins/<name>` or `<dorkHome>/plugins/<name>`).

Lifecycle (all of it inside a per-`target` lock — see below):

0. **Take the target lock.** The whole lifecycle runs inside `withInstallTargetLock`, which wraps `withFileLock` (`@dorkos/shared/atomic-write`) on the **realpath-resolved** `target`, so a second transaction aimed at that directory — under any spelling — waits instead of interleaving. Two installs of _different_ packages still run concurrently. The uninstall flow takes the same lock.
1. **Settle an interrupted earlier install.** `settleInterruptedInstall(target)` settles whatever a crashed transaction left beside the target (see §5.0). It refuses — changing nothing — when a rollback fails or another running DorkOS may be mid-install on the target. It runs again between steps 3 and 4.
2. **Create staging dir.** `mkdtemp(path.join(os.tmpdir(), 'dorkos-install-<name>-'))`.
3. **Stage.** Call `opts.stage({ path: stagingDir })`. A thrown error removes the staging dir and re-raises. No record has been written yet, so `target` is left untouched.
4. **Write the record.** If `target` exists, move it aside to a sibling backup record, `<target>.dorkos-bak-<createdAt>-<owner>-<uuid>`, via `atomicMove` (a sibling keeps it on the same filesystem, so the move and any restore are cheap atomic renames). A fresh install writes an empty `<…>.absent` marker instead.
5. **Activate.** Call `opts.activate({ path: stagingDir })`, which performs its `atomicMove(staging, target)` and any follow-up (extension enable, adapter registration, agent scaffolding).
6. **Commit.** Rename the backup to `<…>.committed`, or delete the `.absent` marker. This one atomic step is the commit point. A failed commit is treated like a failed activation (step 8), because recovery would undo an uncommitted install anyway.
7. **Success cleanup.** Delete the committed backup and the staging directory. Both are best-effort: the install is committed, and a leftover `.committed` backup is deleted by the next recovery.
8. **Failure rollback.** Roll the record back — remove any partially-written `target`, then put the backup back (or delete the `.absent` marker) — and remove the staging directory. The original error is always re-raised. A rollback failure is logged, never thrown, and leaves the record on disk so the next recovery finishes the job.

The net guarantee, **crashes included** (outside the update window in §5.0): either the package is fully installed and visible, or (for a fresh install) it never existed, or (for a reinstall) the previous installation is intact.

### 5.0 Crash recovery (DOR-2273)

A crash skips steps 7 and 8, so recovery reads the record instead (`services/marketplace/install-recovery.ts`). An uncommitted record (a plain backup, or `.absent`) means the install never finished: it is rolled back, newest first when several stack up. A `.committed` record means it did: it is deleted. Nothing on disk can say whether a half-activated target is whole — an agent's files land before its workspace is scaffolded, and a cross-device move is a recursive copy — so the commit record, not the target's contents, is what "whole" means. A backup is therefore deleted only after the install that replaced it committed. (Until DOR-2273 a startup janitor deleted any backup older than a day, which destroyed the only good copy when a crash had left the target missing or half-written.)

**Backups from before commit records existed** (`<createdAt>-<uuid>`, no owner) are ambiguous: the old code left one behind after a crash (whole copy) and after a failed delete following a _successful_ install (possibly partial copy, whole target). So a `legacy-backup` is restored only when the target is missing. Beside an existing target both are kept and logged, and the next install or uninstall of that target that finishes deletes it (`releaseSupersededRecords`) — otherwise a later uninstall would leave a missing target for recovery to "restore".

**Nothing made later is undone.** A target created (birthtime, or ctime where the filesystem records none) more than `IN_FLIGHT_FLOOR_MS` after its record was written is someone's own work, not the dead transaction's, so a `backup` or `.absent` record beside it is kept with the target rather than restored over it or removed with it. Kept records of every kind are released only after the caller's own change commits — a failed install or commit leaves them.

**Where recovery runs**, always under the target's lock:

- At the start of every transaction, and again right before its record is written — staging runs `npm install` and can take minutes, long enough for another server to start on the same target.
- At the start of every uninstall. `locate()` treats a root with records beside it as a candidate even when the root is missing, so a package a crash left only in its backup is found and removed, not reported "not installed" and later resurrected.
- At server startup for the global roots, before the app serves anything, and once Mesh has reconciled for every registered agent's project — plus the project an installed agent lives in (`<project>/.dork/agents/<name>`). `backup-janitor.ts` sweeps every directory a transaction writes into: the install roots **and the skills roots** schedules are materialised into (`<dorkHome>/skills/`, `<project>/.agents/skills/`). A project that received an install but holds no registered agent cannot be enumerated; its records are settled by the next install or uninstall there.
- A target skipped at startup because another process may own its record is swept once more after `IN_FLIGHT_FLOOR_MS` (`retryInFlightTargetsLater`).

**Another process's live install is never touched.** The lock is per process, and two servers with different data directories can share a project. Each record's name carries its writer (`lib/record-owner.ts`: pid, start time read by `ps`, and a hash of hostname plus, on Linux, pid namespace), and recovery acts on a record only when its writer is this process, is provably not running, or the record's `createdAt` is at least `IN_FLIGHT_FLOOR_MS` (10 minutes) from now in either direction (a clock set back leaves future-dated records). Unreadable start times, Windows, and another machine (a synced project folder) all fall back to that floor. A target with such a record is left entirely alone by the sweep, and a new install of it refuses, saying how many minutes until the floor lets it through. Residuals: a wall-clock step of more than two minutes between a writer stamping its start time and another process checking it can make a live writer look gone (the server reads its own start time at boot to keep its side short), and two servers that check the same package in the same project within the microseconds between the second check and the record's rename.

**What recovery does not cover.** `update()` is an uninstall (which stages the live package and its preserved `.dork/data/` and secrets in the system temp directory), a removal of the data-only root, then an install. A crash between the uninstall and the install's commit is invisible to recovery — nothing beside the target describes a package sitting in the temp directory. DOR-2245 replaces that uninstall with an in-place one that journals itself. And rolling back restores the target directory only: a Mesh registration, the agent-created hook or an enabled extension that `activate` produced is not undone, on the crash path exactly as on the activate-failure path.

**Adding a kind of sibling** (DOR-2245's in-place uninstall is the next): add a row to `INSTALL_RECORD_POLICIES` in `install-recovery.ts` — its marker, whether its stamp carries an owner, its suffix, and its phase: `finished` (deleted) or `unfinished` with a `recover` that settles it and reports `rolled-back`, `rolled-forward` or `kept` — and add its marker to `MARKETPLACE_INSTALL_SIBLING_MARKERS` in `@dorkos/shared/marketplace-schemas`. Every reader of an install root or a skills root skips siblings through `isInstallSiblingName` — including watchers, whose events never pass through a scanner (the task file watcher arms a schedule straight from an event); `__tests__/install-sibling-readers.test.ts` fails when a new reader (a `readdir`, `chokidar.watch` or `fs.watch` over such a root) does not, or when anything spells a marker of its own. The sweep, the ownership check (`lib/record-owner.ts` is exported for siblings outside this grammar) and the per-target recovery pick the new row up unchanged.

**Why step 0 exists (DOR-711).** Steps 4 and 8 are a pair — a rollback restores the snapshot step 4 took — and without serialisation two transactions on one directory could split that pair apart. A took the existing target as its backup; B then found no target at all and installed with no backup of its own; B succeeded; A's activation failed and its rollback deleted the target (B's fresh content) to put A's now-stale backup back. A failed install destroyed a successful one, and both callers got the response they expected. The lock makes move-aside → activate → rollback one critical section, so that interleaving cannot be built. No flow calls `runTransaction` from inside another transaction on the same target, and none should — the inner one would run with the outer one's backup already taken (schedule materialisation runs after a flow's transaction has settled, not inside it).

**The key is canonical, not the caller's spelling.** `withFileLock` keys on `path.resolve`, which normalises `..` but does not follow symlinks — and its own header tells callers not to lean on the key normalising for them. A project-scope target is built by joining a caller-supplied `projectPath`, so `/work/proj` and a symlink `/work/current` pointing at it are one directory under two keys, which is no lock at all. `withInstallTargetLock` therefore realpaths the target (resolving through its deepest existing ancestor, since a fresh install's target does not exist yet) before locking. The install/uninstall/update/preview routes independently pass the canonical `projectPath` that their boundary check already resolved, instead of the raw body string — belt and braces. The tier-gate calls still hash the **raw** arguments, so an approval token minted by `dorkos call marketplace.uninstall` is still honoured.

**Uninstall shares the lock.** `flows/uninstall.ts` does not use `runTransaction`, but it has the identical destructive pair (move the install root aside; restore that copy if a side-effect throws), so it takes `withInstallTargetLock` on the located install root. Its `locate()` runs outside the lock — the path to lock is not known until it has — and the residue there is loud rather than destructive: inside the lock the flow first settles any interrupted install at that root (§5.0) and reads it again, so a package removed between the probe and the lock — or a half-written fresh install that settling removes — is reported as not installed.

**Update holds the lock across both of its halves (DOR-1722).** `MarketplaceInstaller.update()` is an uninstall, a by-hand removal of the data-only install root, and then a fresh install. Each half takes the lock for itself, and while that was all the serialisation there was, the gap between them was open: an install that landed in it was deleted by that by-hand `rm` — no backup, no error, its caller already told it had succeeded. So `update()` now takes `withInstallTargetLock` once, around the lot. To let the halves keep taking it from inside that hold, `withInstallTargetLock` is **re-entrant for anything the holder's async context reaches**: a call whose canonical key an outer call in the same context already holds runs inline instead of queueing behind its own caller (`withFileLock` throws in that situation, which is the right default for a file writer and a hard stop for a composite operation). Exclusion is unaffected for nested work — the outer hold is what keeps other contexts out, and one async context cannot race itself. Read the grant as "every continuation the holder's context propagates to", not as the dynamic extent of the hold: work that escapes the critical section (a `setTimeout` scheduled inside it) still carries the `AsyncLocalStorage` store afterwards, and a take from there runs inline against a target nobody holds. `withFileLock` has the same property, but an escape there throws loudly where this one is silent, so it fails open; no marketplace caller schedules work that outlives its critical section, and whoever writes one takes the lock from a context that does not already hold it.

Locating the install root is the one step outside the lock, with the same narrow, loud residue the uninstall flow has. `update()` and the uninstall flow probe the same candidate roots in the same order — both call `installRootCandidates` (`lib/locate-install.ts`), which derives its roots from `installRootsUnder`, project scope first. Two orders would mean `update()` serialising on a directory the uninstall never touches: since DOR-994 widened the project scope to every install root, that includes locking a global `plugins/foo` while the uninstall removes a project's `agents/foo`.

**One residual, named on purpose: cross-process.** The lock lives in one process's memory. That matches the deployment for global installs, but a project-scope install writes under `{projectPath}/.dork/`, which is keyed to the project rather than to a `dorkHome` — and the dogfood setup runs two servers (dev on :6242, the built app on :4242) that can be opened on the same project. The acceptance `atomic-write.ts` states for its own cross-process edges does **not** transfer here: there, losing mutual exclusion degrades to last-writer-wins over a whole file; here it degrades to the destruction above. Closing it needs an on-disk lock, which is a separate decision. The owner stamped into each transaction record (§5.0) narrows it: a transaction that finds another live server's record beside its target — before staging or right before writing its own — refuses to start, so what is left is two servers checking the same target within the microseconds between that second check and the record's rename.

### 5.1 npm dependencies

A package may ship runtime code that imports from npm — the `/flow` plugin's `scripts/*.ts` import `zod`. Copying those files onto disk is not enough: without a `node_modules` beside them the first `node --experimental-strip-types <plugin>/scripts/dispatch.ts` dies with `ERR_MODULE_NOT_FOUND` (DOR-1341). So every install flow's `stage` callback, after the package contents are copied and before the transaction takes its backup, calls `installStagedNpmDependencies` (`lib/npm-dependencies.ts`). When the staged package root declares dependencies, that runs one `npm install` in the staging directory (`npm.cmd` on win32), bounded at 120 s with `SIGKILL`.

**The containment model.** Running a package manager inside a directory a stranger authored is the dangerous part, and npm takes instructions from that directory in three ways that all had to be closed. The doctrine is the one `lib/stage-package.ts` already applies to symlinks: strip the capability unconditionally rather than reason about whether this particular use of it is benign.

- **The argv carries the guarantees**, because a command-line flag is the only npm setting a config file cannot override. `--ignore-scripts` (no lifecycle code, from the package or any dependency of it), `--global=false` (npm may only write inside the staging directory), `--no-workspaces` (only the package root, which is what the preview disclosed). Then `--omit=dev --no-audit --no-fund --loglevel=error` for hygiene.
- **The package's own root `.npmrc` is stripped** — during the staging copy (`stage-package.ts`, so it never reaches disk) and again defensively before the spawn. It is not a preference file: `global=true` in it turns a plain `npm install` into a global install of the package **itself**, planting bin shims — a shim named `git`, `claude` or `dorkos` runs the package's code the next time anyone types that command — with npm exiting 0 and nothing written inside the staging tree for a rollback to undo. `registry=` and `cache=` redirect where bytes come from and go. `--global=false` closes the worst of it, but the file would still be sitting at the install root, where the remedy DorkOS prints for a failed dependency install ("run `npm install` in `<path>`") would walk the person straight into it. Only the **root** copy is dropped; one nested in the package is inert content. The **user's** `~/.npmrc` is untouched — private-registry auth lives there.
- **Symlinks npm re-introduces are stripped after it returns.** `stage-package.ts` strips links as it copies (DOR-279), but npm runs afterwards: a `file:` dependency makes it mint a brand-new link to anywhere on the machine (`node_modules/peek -> ../../secretdir`), readable for as long as the staged tree lives. Every link under the staged `node_modules` whose real path leaves the staging directory is removed, and the person is told; npm's own `.bin` shims resolve inside the tree and survive. A link that cannot be resolved at all is removed too — "dangling right now" is a property of the machine, not of the package.

Each of those has a test that drives the **real** npm against a hostile fixture, because a stub only proves which flags we pass, not that they work. All three fixtures were confirmed to do the bad thing before the fix.

Two more rules:

- **It runs on the staged tree, never on the activated one.** The `node_modules` it creates is activated by the same atomic `atomicMove` as the package files, so a rolled-back install leaves neither behind and a reinstall's previous `node_modules` is restored with everything else.
- **A dependency problem warns; it does not fail the install.** No `npm` on the machine, a non-zero exit, a timeout, an offline registry — each comes back as one sentence on `InstallResult.warnings` naming the exact command to run by hand. Failing would roll back a package whose own commands, skills and docs work fine. The half-written `node_modules` is removed first, so the state is a clean "not installed" rather than a partial tree that looks installed. The same sentence is carried on `InstallResult.dependencyWarnings`, persisted to the package's `install-metadata.json` sidecar and re-shown by `InstalledPackagesView` — a package that is on disk but incomplete outlives the toast that said so.

Consumers of the staged tree must skip `node_modules`. `findSkillFiles` in `install-skill-pack.ts` does: a vendored dependency shipping any file named `SKILL.md` that the parser rejects would otherwise **throw** and roll the whole install back, over a file the package author neither wrote nor can fix.

The permission preview reports the declared `dependencies` **and** `optionalDependencies` as `npmDependencies: { name, range, optional? }[]` (section 6), and **both** consent surfaces name every library before the person approves the network fetch: the app's install dialog (`features/marketplace/lib/format-permissions.ts`) and `dorkos install`'s terminal preview (`packages/cli/src/lib/preview-render.ts`). Both say "and everything they depend on", because the count is what the package declared and one declared library routinely pulls dozens more. `node_modules` stays out of `fileChanges` as it always has.

A new flow gets none of this for free — the call lives in each flow's `stage`, not in `runTransaction` (`services/shapes/fork.ts` shares the engine and must not npm-install). Step 2 of section 9 is where to add it.

### Why file-scoped and not git

The rollback operates on the install target directory using pure filesystem moves. That is deliberate: the install target is `<dorkHome>/plugins/<name>` or a project-local `.dork/` subtree (not `process.cwd()`), and installs write gitignored `.dork/` files that a `git reset` can neither restore nor remove. The superseded ADR-0231 rollback ran `git reset --hard` against `process.cwd()`, which protected the wrong tree, could not touch gitignored files, and destructively reverted every uncommitted tracked-file change in the whole repo (forcing every test to mock `isGitRepo`). ADR-0304 has the full rationale.

There is no `isGitRepo` mock and no `git reset --hard`. Tests exercise the engine against a temp `dorkHome`; the `_internal` export surfaces only filesystem helpers (`moveTargetAside`, `cleanupStaging`, `removePath`) for simulating cleanup or restore failures. The `install-adapter` flow still keeps its own compensating `removeAdapter` call, because a filesystem restore cannot reach the `relay-adapters.json` config file. Uninstall uses its own non-git staging + restore path, under the shared per-target lock.

The concurrency guarantees have their own suite (`__tests__/transaction-concurrency.test.ts`): it drives two real transactions against real temp directories and asserts on the **bytes that survive**, never on what the calls returned. Nothing there is stubbed, because the defect it pins is an interleaving of the engine's own steps — a mock of either step would only encode the hypothesis. A sequential test cannot fail any of those assertions.

## 6. Permission preview

Every install is preceded by a `PermissionPreview` — a complete inventory of what the package will do, built before any disk mutation. The full shape (`apps/server/src/services/marketplace/types.ts`):

```typescript
export interface PermissionPreview {
  /** What will be created on disk. */
  fileChanges: { path: string; action: 'create' | 'modify' | 'delete' }[];
  /** Extensions that will be registered. */
  extensions: { id: string; slots: string[] }[];
  /** Shell hooks the package registers with the harness, commands verbatim. */
  hooks: { event: string; matcher?: string; command: string }[];
  /** Hook declarations the package ships that could not be read. */
  unreadableHooks: { path: string; event?: string }[];
  /** Scheduled jobs that will be created, and what each may do unattended. */
  schedules: {
    name: string;
    cron: string | null;
    permissionMode: SchedulePermissionMode;
    startsEnabled: boolean;
  }[];
  /** Secrets the package will request. */
  secrets: { key: string; required: boolean; description?: string }[];
  /** npm libraries the install will fetch from the registry (section 5.1). */
  npmDependencies: { name: string; range: string; optional?: boolean }[];
  /** External hosts the package will contact. */
  externalHosts: string[];
  /** Other packages this depends on. */
  requires: { type: string; name: string; version?: string; satisfied: boolean }[];
  /** Conflicts with already-installed packages. */
  conflicts: ConflictReport[];
}
```

The builder (`services/marketplace/permission-preview.ts`) walks the staged package and reads:

- `.claude-plugin/plugin.json` for declared skills / hooks / MCP servers.
- `.dork/extensions/*/extension.json` for slot registrations and declared secrets.
- `hooks/hooks.json` for the shell commands the package **declares**. Parsing mirrors `readPluginHooks` in `packages/harness/src/sources/installed.ts`, the reader that feeds Harness Sync, including its tolerance for both the `{ hooks: {…} }` wrapper and a bare `{ Event: […] }` object. Every declaration the preview fails to parse lands in `unreadableHooks`, because "declares hooks we could not read" is a worse signal than "declares no hooks" and the two must never render alike.

  The preview cannot be the only disclosure, because it runs BEFORE the install: a `hooks/hooks.json` that rots afterwards — a hand-edit, a partial write — reaches only the Harness Sync reader, and the CLI path has no approval gate to re-ask through. So `readPluginHooks` records every declaration it salvages around on the plugin as `unreadableHooks`, and the projector turns each one into a `ProjectionWarning` naming the file and the event, printed by `dorkos harness sync` (DOR-1724). The two sides disclose the same losses at the two moments they can happen.

  **Declared is not the same as projected, and the UI copy says so.** A package's hooks only reach a harness settings file when three things hold:
  1. the install is **project-scoped** — `installed.ts` records global installs as identity-only and never reads their hooks;
  2. the package is a **`plugin` or `skill-pack`** — `projector.ts` filters to `PROJECTABLE_PLUGIN_TYPES`, and an `agent` or `shape` lands outside `plugins/` so it is never scanned at all;
  3. a person has **approved that exact command set** for that project — `services/harness/hook-approval.ts` (DOR-522) gates projection on the hook CONTENT rather than on the install, keyed by `<packageName>@<digest>`.

  The app's default install scope is global, so "will run" would over-claim in the common case; both preview surfaces therefore say the package **"declares"** these commands. The preview still reports them for every type and scope, because the file does land on disk, a later project-scoped install would surface them for approval, and under-reporting a shell command is the dangerous direction. The two surfaces answer different questions: the preview is what a person reads _before installing_, and the DOR-522 card is what they answer _before those commands can run_. Note that `packages/marketplace/src/package-validator.ts` has no `hooks` check, so nothing rejects a decorative `hooks/hooks.json` on a Shape or agent.

- `.dork/tasks/*/SKILL.md` for scheduled jobs (name, plus `cron`, `permissions` and `enabled` inside the file's `schedule:` block). Read with the unified skill schema since DOR-1486: a package still writing those fields at the top level declares no schedule at all, because nothing materializes or discovers one from there.
- `manifest.schedules` for a Shape's scheduled jobs. Both disclosed fields report what the install will ACTUALLY do, not what the manifest asked for, because two apply-time rules override it (DOR-607) and echoing the raw declaration would be wrong in the alarming direction:
  - `permissionMode` runs through `clampSchedulePermissionMode`, which lives in `services/tasks/schedule-permission-clamp.ts` — one function, imported by `apply-shape.ts` and by this preview rather than copied into either, so the preview cannot drift into warning about a `bypassPermissions` job the installer would never create.

    **The task SKILL.md path goes through the same clamp**, because both sources end at the same schedule row. `TaskStore.upsertFromFile` applies it too, so a package's `.dork/tasks/*/SKILL.md` cannot arm an unattended bypass any more than a Shape manifest can — a file on disk is nobody's approval, and the bar to write one is low (an agent already running in `acceptEdits` writes it with no prompt and no shell). The single exception is a bypass **already in the row**, kept only while that row is `active` and still holds the same prompt, cron and timezone the file carries, so the grant is bound to a live task doing the work a person approved rather than to a path. That exception is the one thing the preview under-reports (an unchanged reinstall over a task the person raised themselves); `readTaskSkills` names it in full.

  - `startsEnabled` reads `startEnabled`. The retired `startDisabled` is deliberately not consulted: it survives in the schema only so apply-time can tell an author it is stale, and inverting an absent key would report every schedule in a modern manifest as starting switched on.

  `apply-shape.ts` may still force a schedule off when its bound agent is missing at apply time, which the preview cannot know in advance, so a `true` remains the more permissive of the two outcomes.

- `.dork/adapters/*/manifest.json` for adapter requirements.
- `package.json` at the package **root** for `npmDependencies` — the `dependencies` and `optionalDependencies` the install will download (section 5.1). Nested workspaces are not chased, and `node_modules` stays out of `fileChanges`.
- The `requires` field on the top-level manifest for dependency resolution against the installed set.

It then delegates to the conflict detector (section 7) and attaches the result to `preview.conflicts`.

The CLI renders the preview to the terminal and prompts for confirmation unless `--yes` is set. The HTTP API returns the preview verbatim via `POST /api/marketplace/packages/:name/preview`, and the marketplace extension UI (spec 03) will render it inside the dialog before the user approves.

## 7. Conflict detection

The conflict detector (`services/marketplace/conflict-detector.ts`) compares a staged package against the active scope — the global `${dorkHome}`, or a project's `${projectPath}/.dork` — and returns a list of `ConflictReport`s. Errors block install unless `--force` is passed. Warnings surface in the preview but never block.

Every installed-side read walks **all** of that scope's install roots, never a hardcoded `plugins/`: the package-name check (over `INSTALL_ROOT_DIRS`), and the bundled-extension and bundled-`SKILL.md` reads (over `installRootsUnder()`). Reading only `plugins/` for extensions and skills was an instance of the pattern DOR-994 removed elsewhere, and it hid real collisions — a Shape installs under `shapes/` and `ShapeInstallFlow` compiles every inline extension it bundles, so a plugins-only read could never see one (DOR-1776).

`services/tasks/task-file-update.ts` was the last plugins-only holdout and was fixed in DOR-1789, but it asks the question differently because it decides whether DorkOS may **write**. `isPackageOwned` ORs three limbs, and a file is package-owned if any one of them says so:

1. **Location alone**, under the roots `INSTALL_ROOT_HOLDS_PACKAGES_ONLY` marks — `plugins/` and `shapes/`, which hold nothing a person put there.
2. **Location plus a marker**, under `agents/`: the file's install directory (the first segment below the root) must carry `.dork/manifest.json` or `.dork/install-metadata.json`. That root also holds every agent a person makes, DorkBot included, so location alone would claim their schedules — the same bug pointed the other way.
3. **A direct marker probe of the owning agent's own directory**, from `meshCore.getProjectPath(agentId)`.

Neither set of limbs subsumes the other, which is why all three are asked. Limb 3 is the only one that reaches a **project-scoped** agent package: its `<repo>/.dork/agents` root is not derivable from anything the route holds, since the scope root derived from the agent's own path is `<agentDir>/.dork`. Limbs 1 and 2 are the only ones that survive **without mesh** — `getProjectPath` answers nothing when mesh failed to initialize or when the agent has left the registry (its rows survive and stay patchable), and the agent's directory does not contain a file that some other agent's skills root symlinks into the package.

Both task doors use it: `update-task-file.ts` refuses to rewrite a package-owned file, and `create-task.ts` refuses to file a new schedule under a package-owned agent at all (via `isPackageOwnedAgent`), since `agentSkillsRoot()` would put it inside the checkout. Deleting such a schedule is still allowed — removing a file from a doomed checkout harms nothing. The create refusal costs a real capability (you cannot schedule work for a marketplace agent without adding it to the package), accepted on the grounds that the capability only ever appeared to work and vanished at the next package update; **DOR-1791** tracks restoring it properly.

Those roots are not exclusively the marketplace's. `${dorkHome}/agents/` holds every agent DorkOS creates (`lib/agents-home.ts`), hand-made ones included, and installed agent packages land among them — which is what the detector wants, since a hand-made agent's skill collides with an incoming package's just as hard as a marketplace one's would.

A package's own installed copy is filtered out of all three comparisons (slot, skill-name, cron) so a reinstall never conflicts with itself. Identity there is `installKey()` — install root **plus** name — never the bare name: an installed `agents/flow` and an incoming `plugins/flow` are different packages that coexist by design, so a name-only filter would suppress a genuine collision between them.

The six collision rules:

| #   | Type             | Severity | Rule                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `package-name`   | warning  | A directory with the same name already exists under one of `${scope}`'s install roots (`plugins/`, `agents/`, `shapes/`). All three paths — same-root reinstall, same name in a different root, and an agent-local install shadowing a global one — are non-blocking warnings: ADR-0304 made overwrite installs atomic, so none of them dead-ends an install. |
| 2   | `slot`           | warning  | A staged extension binds the same `slot` + `priority` as an installed extension. Last-installed wins — the detector flags but does not block.                                                                                                                                                                                                                 |
| 3   | `skill-name`     | error    | A staged `SKILL.md` has the same `name` as an installed one at the same scope. Tasks share this rule because only `SKILL.md` exists today; a separate task manifest is not yet defined.                                                                                                                                                                       |
| 4   | `cron-collision` | warning  | A staged task's cron expression shares the same minute field as an installed one. Heuristic — no AST parsing in v1.                                                                                                                                                                                                                                           |
| 5   | `adapter-id`     | error    | An adapter package's `adapterType` matches an already-configured adapter `id` from `AdapterManager.listAdapters()`.                                                                                                                                                                                                                                           |
| 6   | `task-name`      | —        | Folded into rule 3.                                                                                                                                                                                                                                                                                                                                           |

The detector is best-effort: malformed JSON, missing files, and unreadable directories are silently skipped so a broken corner of the install tree cannot block a legitimate install. If you need strict validation, the package validator is the right layer; the detector is only a pairwise comparison against the already-installed set.

`ConflictDetector` takes `dorkHome` and an `AdapterManager` instance via its constructor, honouring `.claude/rules/dork-home.md` (no fallback chains). The detection context argument has its own `dorkHome` field for spec parity, but the constructor value is authoritative.

## 8. Cache layout

All marketplace caching lives under `${dorkHome}/cache/marketplace/` and is managed by `services/marketplace/marketplace-cache.ts`. See [ADR-0232](../decisions/0232-content-addressable-marketplace-cache-with-ttl.md) for the dual-TTL rationale.

```
${dorkHome}/cache/marketplace/
├── marketplaces/
│   └── dorkos-community/
│       ├── marketplace.json    # Last-fetched copy (TTL governed)
│       └── .last-fetched        # ISO timestamp stamp
└── trees/
    ├── code-review-suite@<40-hex commit>/            # Exactly that commit's tree
    └── flow@<40-hex commit>~<12-hex digest>/         # A git-subdir entry: sparse,
        └── plugins/flow/                             #   only the package's directory
```

Two cache disciplines side by side:

- **`marketplace.json` — 1h TTL.** Past the TTL, the cached entry is still served but flagged `stale: true` so the caller can choose to refresh in the background. On network failure, the stale entry is served verbatim — this is the offline fallback.
- **Package trees — never expire, but are swept.** The tree of commit `a1b2c3d…` is the same today, tomorrow, and a year from now, so a TTL would only ever make things worse. What bounds them is retention (below); `dorkos cache clear` wipes everything.

**Retention** ([ADR 260923-193906](../decisions/260923-193906-package-cache-sweeps-itself-on-write.md), DOR-2249, `services/marketplace/package-cache-retention.ts`). An entry is kept when any of these holds, and a sweep removes it otherwise:

1. **In use:** it was handed out in the last `IN_USE_GRACE_MS` (15 minutes). `getPackage`, `materializePackage`'s fast path and the landing of a fetch stamp the entry's mtime, so an entry's mtime (`CachedPackage.lastUsedAt`) is its last use. The cache enforces this itself in `removeUnused`; no caller can waive it. Stamping is best-effort: a tree DorkOS can read but not stamp (root-owned, read-only disk) is still served.
2. **Recorded:** an installation records its commit (`commitSha`, plus `sourceKey.subpath` when present; a sidecar without a `sourceKey` protects every entry at that commit). Matched by commit, never by name: a direct `name@url` install keys the cache by the typed name, while the sidecar records the manifest's. Rebuilding an install's file record fetches this commit (DOR-2245).
3. **Newest of an installed package:** among the entries rule 2 does not already keep, the most recently used of each `(name, subfolder digest)` group an installation belongs to — the staged update when one is pending. Excluding rule 2's entries means re-reading the installed commit never costs the staged update its place; after an update is applied, the superseded tree can hold this slot until the next update is staged. Groups nothing installed belongs to keep nothing beyond rule 1, so browsing and previewing never pin entries.

The cache therefore holds at most two entries per installed package. `PackageCacheRetention` is the one owner: `MarketplaceCache.onEntryWritten` fires after a fetch lands a new entry (the only way the cache grows), and the owner runs a sweep; it also sweeps once at startup and on `POST /cache/prune` (`dorkos cache prune`). Sweeps are coalesced — one runs, at most one waits, and every request in between shares it — so a 20-package update check costs one or two. There is no timer and no size budget: the rule already bounds the cache by what is installed. Uninstalling frees disk at the next sweep, not immediately.

**What installs record is read strictly** (`listRecordedTrees`), because a sweep deletes whatever that read misses. It reads the global install roots, every registered agent's project, and the **project install record** (`lib/project-install-index.ts`, `<dorkHome>/marketplace/project-installs.json`). The installer writes one entry there per install that lands inside a project (`recordProjectInstall`, called from `MarketplaceInstaller.install` right after the sidecar, best-effort), with its commit and subfolder. That is how installs in folders that are not registered agents — including those an unregistered agent left behind — are found. The sweep removes nothing, and logs why (`POST /cache/prune` answers 503), when: the agent registry is unavailable; a registered agent's project folder is missing (an unplugged drive looks exactly like this); an install root or a sidecar exists but cannot be read; or a sidecar or the record does not parse. A folder that does not exist is simply empty, and the install engine's own siblings (`isInstallSiblingName`, such as a crash-left backup) are skipped: they are bookkeeping, and a restored one is read as an install from then on. A recorded install that cannot be reached is protected by its record, which is dropped only when its project folder exists and its install folder does not (it was uninstalled) — never on an error. The drop is a compare-and-delete inside the record's write chain: it re-checks that the install folder is still missing and that the record still names the commit the sweep read, so a reinstall that recorded in between keeps its record. A deleted project's records stay (they look like an unplugged drive) and pin their commits' trees, a small bounded leak. Writes are fsynced before their atomic rename; a record file that still does not parse stops sweeps until the next project install moves it aside to `project-installs.json.corrupt-<time>` and starts fresh. Project installs made before the record existed are found only through the agent registry.

**A paused cleanup is visible.** `PackageCacheRetention.status()` keeps the last sweep's outcome, and `GET /cache` returns it as `cleanup: { paused, reason, since }` (`reason` is a plain fragment such as `couldn't read /Volumes/Work/app (the folder is missing)`). `dorkos cache list` prints `Automatic cleanup is paused: <reason>` while it is. The pause is logged at warn once per change of reason, not on every sweep, and its end at info. A missing registered-agent folder normally stops pausing within a day, when the mesh reconciler removes the unreachable agent (24 hours).

Concurrency: every reader of a cache entry is in this server process (one server holds a data directory, `lib/instance-lock.ts`). "Exists? stamp it" (both read paths and the landing of a fetch) and "still unused? rename it aside" (a sweep) run under one in-process lock (`exclusive`, a promise chain), so a sweep can never remove an entry between a reader's check and its stamp, and the grace covers the reader afterwards. A swept entry is renamed to `trees/.tmp-prune-<uuid>` and deleted outside the lock; `removeLeftovers` deletes any a crash left. Sizes (`lib/directory-size.ts`, also used by `GET /cache`) never follow symlinks: git keeps them, and `a -> .` would otherwise walk for ever.

**An entry's key is the commit its checkout holds** ([ADR 260923-162950](../decisions/260923-162950-cache-entry-keyed-by-the-verified-checkout.md), DOR-2248). There is one way in, `MarketplaceCache.materializePackage(name, expectedSha, subpath, fetch)`: the fetch populates a temp directory and returns the commit it checked out, the cache names the entry after that commit, and it refuses anything that is not a full commit id (`isFullCommitSha`). `expectedSha` only short-circuits a tree already cached under it and de-duplicates concurrent fetches. So no entry is ever keyed by a lookup, a placeholder, or a guess. A sparse checkout is a different tree from the whole repository at the same commit, so a `git-subdir` entry's key carries the first 12 hex digits of its subfolder's SHA-256 (`flow@<sha>~<digest>`), and `getPackage` takes the subfolder too. Entries from before this rule lived under `packages/`; nothing reads them. At startup, before any route exists, the server calls `removeLeftovers`, which deletes that directory and any `trees/.tmp-fetch-*` or `trees/.tmp-prune-*` a crash left behind.

**How a tree is fetched** (`lib/git-tree.ts`, behind `PackageFetcher.fetchGitTree`, which all three git forms share):

1. **Resolve the ref exactly** (`lookupRemoteRef`): a full commit id is itself; `HEAD` is the default branch; a `refs/…` name is taken as written; any other name is `refs/heads/<ref>`, then `refs/tags/<ref>` (the order `git clone --branch` uses), with an annotated tag peeled to its commit. `git ls-remote` is asked for those qualified names, never the bare name, because it matches the tail of every ref (`main` also returns `refs/heads/x/main`). A ref the remote lacks throws `GitRefNotFoundError`; a remote that cannot be asked throws `GitRemoteUnreachableError`. Nothing is fetched in either case.
2. **Fetch that commit by id**: `git init`, a temporary remote, and `git fetch --depth=1 <commit>`. A push after the lookup cannot change what arrives. A `git-subdir` subpath is first tried as a blob-filtered partial clone with a sparse cone (`sparse-checkout init --cone`, then `set`), so only the package's own files download.
3. **Fallback** only when the server refuses an unadvertised object (protocol v0 without `uploadpack.allowReachableSHA1InWant`). Such a server also refuses a partial checkout's lazy blob requests, so a partial clone that fails in any way starts over unfiltered, once. Unfiltered, a refused commit falls back: a named ref fetches the exact refname and keeps whichever commit arrives (the ref moved; the entry and the record follow the tree); a pinned commit fetches every branch and tag and then requires the commit, else `GitCommitNotFoundError`.
4. **Verify**: check the commit out; require no `error:` line from the checkout, `git rev-parse HEAD` equal to the commit, and an empty `git ls-files --deleted` (git 2.30–2.36 can exit 0 from a checkout whose lazy blob fetch was refused, with `HEAD` right and the file missing); remove `.git`; return the commit. Any failure is a `GitFetchError` with git's reason, tokens redacted.

Every git call keeps the marketplace's posture: `assertSafeGitRemote` first, `hardenedGitEnv`, argv arrays, and `--end-of-options` before every author-supplied value. The GitHub token goes only to a GitHub host, as an `http.<origin>/.extraHeader` passed through `GIT_CONFIG_COUNT` (`gitHubAuthConfig`), so it is on no command line and in no `.git/config`; the token is resolved at most once a minute. A source with no ref is fetched at `HEAD`, the repository's default branch.

**Git floor, measured, not assumed.** `scripts/git-floor-probe.sh` replays the exact command sequence in Docker. git 2.26 through 2.49 pass (alpine/git 2.26.2, 2.30.0, 2.34.2, 2.36.3, 2.40.1, 2.43.0, 2.45.2, 2.49.1; Ubuntu 24.04's 2.43.0). git 2.24 has no `sparse-checkout`. Two version traps shaped the commands. `checkout --detach` rejects `--end-of-options` up to 2.43, so the checkout names the verified commit bare. And `sparse-checkout set --cone` leaves cone mode off before 2.35, so cone mode is set with `init --cone` first. Git 2.26 also refuses a filtered fetch into a fresh repository, so the partial-clone settings are written by hand. The token header needs git 2.31, when `GIT_CONFIG_COUNT` arrived. On git older than 2.31, which cannot read config from the environment, the token is embedded in the remote URL instead, exactly as `execGitClone` does (`withGitHubToken`); the installed git's version is read once per process (`git --version`, vendor suffixes such as Apple Git's tolerated), and an unreadable version takes the URL form, which works on every git. That URL lives only in the temporary repository's `.git`, which is removed before the tree is cached, with the temp directory on failure, and by the startup sweep after a crash; git's messages are redacted. With `PROBE_TOKEN` and `PROBE_PRIVATE_REPO` set, the probe authenticates both ways against a private repository (measured: 2.26.2 and 2.30.0 by URL, 2.49.1 by header) and checks the token is gone once `.git` is. Re-run the probe whenever `git-tree.ts` changes a git command; `git-tree-guards.test.ts` pins the argv it measured.

`PackageFetcher.fetchAtCommit({ packageName, sourceKey, commitSha })` fetches one exact commit whatever ref the source names: the way to rebuild an install recorded at a commit its branch has since moved past.

Torn-write safety: `writeMarketplace` writes `marketplace.json` before stamping `.last-fetched`, so a crash mid-write leaves the cache in a "no stamp → cache miss" state rather than serving stale content with a fresh timestamp.

Scoped package names are handled correctly: `parsePackageDirName` uses `lastIndexOf('@')`, so `@scope/pkg@deadbeef` splits into `@scope/pkg` + `deadbeef`.

## 9. Adding a new install flow

A concrete recipe for a hypothetical `theme` package type.

**Step 1 — Update the package type schema in `@dorkos/marketplace`.**

Add `'theme'` to the `PackageType` union in `packages/marketplace/src/schemas/package-manifest.ts` and define a `ThemePackageManifest` extending the base schema with any theme-specific fields.

**Step 2 — Create `services/marketplace/flows/install-theme.ts`.**

Match the existing flow constructor pattern. At minimum:

```typescript
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ThemePackageManifest } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { atomicMove } from '../lib/atomic-move.js';
import { installStagedNpmDependencies } from '../lib/npm-dependencies.js';
import { stagePackageContents } from '../lib/stage-package.js';
import { runTransaction } from '../transaction.js';
import type { InstallRequest, InstallResult } from '../types.js';

export interface ThemeFlowDeps {
  dorkHome: string;
  logger: Logger;
}

export class ThemeInstallFlow {
  constructor(private readonly deps: ThemeFlowDeps) {}

  async install(
    packagePath: string,
    manifest: ThemePackageManifest,
    opts: Pick<InstallRequest, 'projectPath'>
  ): Promise<InstallResult> {
    const installRoot = path.join(this.deps.dorkHome, 'themes', manifest.name);
    const warnings: string[] = [];

    const result = await runTransaction<InstallResult>({
      name: `install-theme-${manifest.name}`,
      target: installRoot,
      stage: async (staging) => {
        await stagePackageContents(packagePath, staging.path, this.deps.logger);
        // Section 5.1 — a package that declares npm `dependencies` gets them
        // installed on the staged tree. Not in `runTransaction`, so the flow
        // has to ask for it; skipping it ships a package that cannot run.
        warnings.push(
          ...(await installStagedNpmDependencies({
            stagingDir: staging.path,
            installPath: installRoot,
            logger: this.deps.logger,
          }))
        );
      },
      activate: async (staging) => {
        await mkdir(path.dirname(installRoot), { recursive: true });
        await atomicMove(staging.path, installRoot);
        return {
          ok: true,
          packageName: manifest.name,
          version: manifest.version,
          type: 'theme',
          installPath: installRoot,
          manifest,
          warnings: [...warnings],
        };
      },
    });

    return result;
  }
}
```

Always use `atomicMove` instead of raw `fs.rename` — see section 13.

**Step 3 — Add to `MarketplaceInstaller`'s dispatch switch.**

In `services/marketplace/marketplace-installer.ts`:

```typescript
case 'theme':
  return this.deps.themeFlow.install(packagePath, manifest, req);
```

The switch is exhaustive — TypeScript will refuse to compile until the new case is handled. Add `themeFlow: ThemeInstallFlow` to `InstallerDeps` as well.

**Step 4 — Wire it in `apps/server/src/index.ts`.**

Construct a `ThemeInstallFlow` under the existing conditional marketplace router mount block (the block gated on `if (extensionManager && adapterManager)`), pass it into the `MarketplaceInstaller` deps object, and you're done. The HTTP routes and CLI commands already dispatch generically via `installer.install(req)` — no changes needed there.

**Step 5 — Add a test fixture under `services/marketplace/fixtures/`.**

Create `fixtures/valid-theme/` with a minimal `.dork/manifest.json`, the theme's payload, and whatever the validator requires. Mirror the structure of `valid-plugin/`.

**Step 6 — Add a flow test.**

Stage a fixture package in a tmp dir, drive the flow against a temp `dorkHome`, and assert the install root ends up populated. Cover the failure path too: make `activate` throw (e.g. a compile or registration error) and assert that a fresh install leaves no residue at the target, and that an overwrite install restores the previous contents. No `isGitRepo` mock is needed, because the transaction engine is file-scoped and touches only the target and a temp staging dir. See section 5.

**Step 7 — Add an integration test.**

Drive the real `MarketplaceInstaller` end-to-end against the new fixture and a temp `dorkHome`. Reuse `buildInstallerForTests` from `integration.test.ts` and assert that the expected files exist after install.

**Step 8 — Add a conflict rule if relevant.**

If the new type introduces its own collision class (e.g. theme IDs must be globally unique), add a new rule and type to `conflict-detector.ts` and extend the `ConflictReport.type` union in `types.ts`.

## 10. HTTP API reference

All endpoints mount under `/api/marketplace/*`. The router factory is `createMarketplaceRouter(deps)` in `apps/server/src/routes/marketplace.ts`. Every response is JSON.

| Method | Path                        | Body                                                   | Response                                                                                                         |
| ------ | --------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| GET    | `/sources`                  | —                                                      | `{ sources: MarketplaceSource[] }`                                                                               |
| POST   | `/sources`                  | `{ name, source, enabled? }`                           | `MarketplaceSource` (201)                                                                                        |
| DELETE | `/sources/:name`            | —                                                      | 204                                                                                                              |
| POST   | `/sources/:name/refresh`    | —                                                      | `{ marketplace: MarketplaceJson, fetchedAt }`                                                                    |
| GET    | `/installed`                | `?projectPath=<path>`                                  | `{ packages: InstalledPackage[] }` — cross-scope by default; see §16                                             |
| GET    | `/installed/:name`          | —                                                      | `{ installations: InstalledPackage[] }` — one per scope; see §16                                                 |
| GET    | `/cache`                    | —                                                      | `{ marketplaces, packages, totalSizeBytes, cleanup: { paused, reason, since } }`                                 |
| DELETE | `/cache`                    | —                                                      | 204                                                                                                              |
| POST   | `/cache/prune`              | — (no options)                                         | `{ removed: [{ packageName, commitSha, path, lastUsedAt }], freedBytes }`; 503 when it cannot read every install |
| GET    | `/packages`                 | —                                                      | `{ packages: AggregatedPackage[] }`                                                                              |
| GET    | `/packages/:name`           | `?marketplace=<name>`                                  | `{ manifest, packagePath, preview }`                                                                             |
| POST   | `/packages/:name/preview`   | `InstallRequestBody`                                   | `{ preview, manifest, packagePath }`                                                                             |
| POST   | `/packages/:name/install`   | `InstallRequestBody`                                   | `InstallResult`                                                                                                  |
| POST   | `/packages/:name/uninstall` | `{ purge?, projectPath? }`                             | `UninstallResult`                                                                                                |
| POST   | `/packages/:name/update`    | `{ apply?, projectPath? }`                             | `UpdateResult`                                                                                                   |
| GET    | `/updates`                  | `?projectPath=<path>`                                  | `{ checks: InstallationUpdateCheck[] }` — advisory, one per installation                                         |
| POST   | `/updates`                  | `{ apply: true, names?, installPaths?, projectPath? }` | `{ checks: InstallationUpdateCheck[] }` — with `applied` / `applyError`                                          |

Where `InstallRequestBody` is:

```typescript
{
  marketplace?: string;
  source?: string;
  force?: boolean;
  yes?: boolean;
  projectPath?: string;
}
```

Error mapping is centralised in `mapErrorToStatus()`:

| Error class                                     | HTTP status |
| ----------------------------------------------- | ----------- |
| `InvalidPackageError`                           | 400         |
| `ConflictError`                                 | 409         |
| `PackageNotInstalledError`                      | 404         |
| `PackageNotInstalledForUpdateError`             | 404         |
| `GitRefNotFoundError`, `GitCommitNotFoundError` | 404         |
| `GitRemoteUnreachableError`, `GitFetchError`    | 502         |
| `PackageNotFoundError`                          | 404         |
| `MarketplaceNotFoundError`                      | 404         |
| (anything else)                                 | 500         |

SSE streaming for clone progress is planned (the spec mentions it following the `discovery/scan` pattern) but deliberately not shipped with this spec — a half-implemented SSE is worse than a unary JSON response that works. A follow-up `POST /packages/:name/install/stream` variant will land in a dedicated task. The current `POST /packages/:name/install` handler has a `// TODO` marker for the wiring point.

The router is mounted in `apps/server/src/index.ts` under the conditional `if (extensionManager && adapterManager)` block — marketplace routes only come up when both the extension subsystem and the adapter manager have initialised, matching how tasks / relay / mesh routes are conditionally mounted.

## 11. CLI command reference

All marketplace CLI subcommands are thin HTTP clients that talk to a running DorkOS server via the API above. Server URL precedence: `DORKOS_PORT` env var → `~/.dork/config.json` → default 4242. None of them starts a server; an unreachable one is an error (`Cannot reach DorkOS server at …`).

**One home: `dorkos marketplace <verb>`.** Package management and source management share the `marketplace` namespace (`commands/marketplace-dispatcher.ts`), matching every other multi-verb domain in the CLI (`cache`, `agent`, `connections`, …) and keeping a bare `dorkos update` from reading as "update DorkOS". The top-level `dorkos install`, `dorkos update` and `dorkos uninstall` are permanent shorthand: `cli.ts` hands them to the same dispatcher, so both spellings run one handler and print one help text (`__tests__/marketplace-shorthand.test.ts` pins that). Usage and error lines name the canonical form. There is no top-level shorthand for `installed` or `outdated`.

```bash
# Install (shorthand: dorkos install)
dorkos marketplace install <name>                         # Latest from any configured marketplace
dorkos marketplace install <name>@<marketplace>           # Specific marketplace
dorkos marketplace install <name> --source <url>          # Direct git or marketplace.json URL
dorkos marketplace install --force <name>                 # Override conflict warnings
dorkos marketplace install --yes <name>                   # Skip confirmation prompt (CI / non-TTY)
dorkos marketplace install --project ./apps/web <name>    # Project-local install

# Uninstall (shorthand: dorkos uninstall)
dorkos marketplace uninstall <name>                       # Remove package, preserve secrets/data
dorkos marketplace uninstall --purge <name>               # Remove everything including data
dorkos marketplace uninstall --project ./apps/web <name>  # Project-local uninstall

# Update (shorthand: dorkos update)
dorkos marketplace update                                 # Check every installation (one request)
dorkos marketplace update <name>                          # Check one package
dorkos marketplace update --apply <name>                  # Actually update (advisory off)
dorkos marketplace update --apply                         # Apply every available update (one request)

# What is installed, and what is behind
dorkos marketplace installed [--project <p>] [--json]     # GET /installed: one row per installation
dorkos marketplace outdated [--project <p>] [--json]      # GET /updates: stale + unchecked only; exit 0/1/2

# Marketplace source management
dorkos marketplace add <url> [--name=<n>]                 # Add a marketplace source
dorkos marketplace remove <name>                          # Remove a source
dorkos marketplace list                                   # List configured sources
dorkos marketplace refresh [<name>]                       # Force-refetch marketplace.json

# Cache management
dorkos cache list                             # Show cache counts and total size
dorkos cache prune                            # Remove cached packages no install needs (also automatic)
                                              # (`cache list` says when automatic cleanup is paused, and why)
dorkos cache clear -y                         # Wipe the entire cache (requires -y/--yes in non-TTY)
```

`cache prune` runs the same sweep the server runs after every fetch (section 8) through `POST /api/marketplace/cache/prune`, and takes no options. Its old `--keep-last-n` (and the endpoint's `keepLastN`) were removed in DOR-2249: a per-name "keep N" deleted the commits installs record.

`dorkos cache clear` requires an explicit `-y`/`--yes` flag in non-interactive mode and prompts interactively otherwise. The confirmation prompt follows the same TTY-aware pattern as `lib/confirm-prompt.ts` used by the install flow.

`dorkos marketplace add <url>` derives a default name from the URL's last path segment (minus `.git`); pass `--name` as the explicit escape hatch. `dorkos marketplace refresh` without a name iterates every configured source via `Promise.allSettled`, so a single failing source never aborts the batch.

`dorkos marketplace update` without a package name is one request to the all-packages door: `GET /updates` to check, `POST /updates { apply: true }` with `--apply`, forwarding `--project` either way. A line for a non-global installation names where it lives (`flow [Alpha]  0.7.2 → 0.7.3`), so the same package in two places reads as two lines. `--apply` lists what it reinstalled and what it could not, and exits 1 when anything failed. A named `dorkos marketplace update <name>` still uses the per-package route.

`dorkos marketplace installed` renders `GET /installed` (`?projectPath=` for `--project`) as NAME / VERSION / TYPE / WHERE, where WHERE is `global` or the agent's name (else its project path). A NOTES column appears only when some row has a note: `linked` (the row carries `linked: true`, a symlinked working copy the update flow never reinstalls), `overrides global` (`scope: 'override'`), or `libraries incomplete` (`dependencyWarnings`). `--json` prints `{ installed }` wrapping the server's `packages` rows untouched (an object, like `outdated`'s, so fields can be added without breaking a reader).

`dorkos marketplace outdated` is one `GET /updates` (`?projectPath=` for `--project`). It prints the `update-available` checks with the same line `update` uses (`lib/installation-label.ts`), then the `unknown` ones under `Could not check:`, and never applies anything. Its exit code follows `diff`: **0** every installation checked and current (or none installed); **1** at least one `update-available`, which wins over unknowns because it is the actionable fact; **2** could not tell, meaning nothing known stale but at least one `unknown`, or the request failed (server down, 4xx/5xx, bad arguments; the dispatcher maps its parse errors to 2, not the generic 1). The route has no 404 of its own, so the app's unknown-route 404 (`code: 'API_NOT_FOUND'`, or a code-less 404) is read as a DorkOS started before the CLI was upgraded and says to restart it; name-less `update` does the same (`lib/package-commands.ts`).

Every package command resolves `--project` against the caller's working directory before sending it (`resolveProjectFlag`). The server would resolve a relative path against its own cwd, which for the desktop app or a server started elsewhere is not the terminal's. A linked install's check carries `linked: true` (set by `UpdateFlow`'s `withIdentity` from the scanner record); `outdated` prints those under `Linked, not checked:` and leaves them out of the exit code, since they are unchecked by design and would otherwise pin the answer at 2. `--json` prints `{ outdated, unknown, linked }`, each the server's own `InstallationUpdateCheck` objects; current ones are left out, and stdout stays empty on failure.

## 12. Telemetry hook

`services/marketplace/telemetry-hook.ts` is a thin registration point for a single process-wide telemetry reporter. The default is a no-op: the installer can call `reportInstallEvent` unconditionally without leaking telemetry concerns into the orchestrator.

```typescript
export interface InstallEvent {
  packageName: string;
  marketplace: string; // Falls back to '<direct>' for git-URL / local-path installs
  type: PackageType;
  outcome: 'success' | 'failure' | 'cancelled';
  durationMs: number;
  errorCode?: string; // When outcome === 'failure': err.name
}

export type TelemetryReporter = (event: InstallEvent) => Promise<void>;

export function registerTelemetryReporter(r: TelemetryReporter): void;
export async function reportInstallEvent(event: InstallEvent): Promise<void>;
```

`MarketplaceInstaller` emits exactly one `reportInstallEvent` call per terminal install state (success, `InvalidPackageError`, `ConflictError`, or a flow failure) with `errorCode = err.name`. Spec 04 will register a real reporter via `registerTelemetryReporter`; until then every install is a silent no-op.

Reporter errors are swallowed — telemetry must never fail user operations. The try/catch inside `reportInstallEvent` is the contract.

For test isolation, a `_resetTelemetryReporter()` helper is exported (`@internal`). Reset the reporter in `beforeEach` of any test that checks telemetry behaviour.

## 13. Cross-platform

Marketplace installs run on macOS, Linux, and Windows. Two rules keep them portable.

### Rule 1: always use `atomicMove` instead of `fs.rename`

`services/marketplace/lib/atomic-move.ts` exports a single function:

```typescript
export async function atomicMove(source: string, dest: string): Promise<void>;
```

On the happy path it's a single `fs.rename`, which is atomic on the same filesystem and avoids the torn-write hazard of a recursive copy. When the rename throws with `errno === 'EXDEV'` — frequently on Linux CI runners where `/tmp` is a `tmpfs` mount distinct from the user's home partition, and on Windows for moves between drive letters or volume mount points — the helper falls back to `cp(..., { recursive: true })` followed by `rm(..., { recursive: true, force: true })` so the observable result is indistinguishable from a successful rename.

All other errors rethrow. `EACCES`, `ENOENT`, `ENOTEMPTY`, and friends bubble up to the transaction engine's rollback path where they belong.

Every install/uninstall flow uses `atomicMove` at every rename site. `marketplace-source-manager.ts` is the single exception — it uses raw `rename` for a same-directory tmp-file swap where the cross-device hazard doesn't apply. If you add a new rename site and it's moving something from `os.tmpdir()` onto `dorkHome`, it must go through `atomicMove`.

### Rule 2: always use `path.join` for filesystem paths

Hard-coded forward-slash path literals (`'a/b/c'`) work on macOS and Linux and break on Windows. Every filesystem path in `services/marketplace/` uses `path.join` or `path.resolve`. The conflict detector walks the installed tree via `join(pluginsRoot, packageName)` rather than template strings. The install flows compute install roots via `path.join(dorkHome, 'plugins', manifest.name)` without exception.

### CI matrix gap

The spec's acceptance criteria called for a cross-platform CI matrix (Linux / macOS / Windows) running the full test suite. As of this guide, the repository has no test workflow in `.github/workflows/` at all — only `cli-smoke-test.yml`, which runs `dorkos --version/--help/init` on Ubuntu and does not invoke Vitest. Adding Windows is blocked on creating a baseline `test.yml` first. This is flagged as a separate infrastructure task, not part of marketplace-02-install.

Until the matrix lands, the guarantees above are enforced by code review and local testing on macOS + Linux. The `atomicMove` helper has its own 7-test unit suite that exercises both the happy path and the EXDEV fallback.

## 14. Testing strategy

Every service in `services/marketplace/` has a `__tests__/*.test.ts` file mocking external dependencies. In addition, two cross-cutting test files exercise the full pipeline:

- `__tests__/integration.test.ts` — end-to-end install of each package type against a real fixture in a temp `dorkHome`. Stubs only the external boundary (`extensionCompiler`, `extensionManager`, `agentCreator.createAgentWorkspace`, `adapterManager`, `templateDownloader`). Exports `buildInstallerForTests` for reuse by new integration tests.
- `__tests__/failure-paths.test.ts` — asserts that network failure during clone, validation failure, activation failure, and conflict detection all leave zero residual files. Also exercises the `force: true` override path.

### Test setup for install flows

Install flow tests run against a temp `dorkHome` (and, for project-local cases, a temp project dir). There is no `isGitRepo` mock and no git safety convention: the file-scoped transaction engine (ADR-0304) only ever touches the install target and a temp staging dir under `os.tmpdir()`, so a failure-path test cannot reach the calling worktree. To simulate a cleanup or restore failure at the engine level, spy on the helpers on `_internal` (`transaction.ts`: `beginRecord`, `commitRecord`, `cleanupStaging`; `install-recovery.ts`: `removePath`, `move`); to simulate a crash, make one of them return a promise that never settles and then run `recoverInterruptedInstall` as the next start would (`__tests__/transaction.test.ts`, "crash windows"); to simulate a mid-activate failure at the flow level, make the injected collaborator (compiler, `enable`, `addAdapter`, `createAgentWorkspace`) reject.

### Failure-path coverage

Every install flow must be tested with simulated mid-install failures to assert rollback works:

- Network failure during clone → no partial files.
- Validation failure after stage → cleanup; target untouched (no backup was taken).
- Activation failure on a fresh install (e.g. extension compile error) → partial target removed; staging dir removed.
- Activation failure on an overwrite install → the previous installation at the target is restored byte-for-byte.
- A crash at each step (record written, mid-activate, before commit, after commit, mid-rollback) → recovery leaves the previous installation, or the finished new one, and nothing else.
- Conflict detection error without `--force` → no files written.
- Conflict detection error with `force: true` → install proceeds.

### Fixtures

`services/marketplace/fixtures/` holds one known-good sample per package type (`valid-plugin/`, `valid-agent/`, `valid-skill-pack/`, `valid-adapter/`, `valid-shape/`) plus `broken/*` directories for validation-failure tests. `fixtures.test.ts` sanity-checks the fixtures themselves. When adding a new package type, add a matching fixture and extend `fixtures.test.ts`.

### Running the suites

```bash
pnpm vitest run apps/server/src/services/marketplace   # All marketplace unit + integration tests
pnpm vitest run apps/server/src/routes/__tests__/marketplace.test.ts  # HTTP API
pnpm vitest run packages/cli/src/commands/__tests__    # CLI subcommands
pnpm typecheck                                          # Whole monorepo
pnpm lint                                               # ESLint (including the SDK-import boundary)
```

The full marketplace suite sits at 174+ tests across source + routes + CLI and runs in under a minute on a laptop. Failure-path tests are the slowest because they spin real temp directories, so keep an eye on parallel-run cross-contamination when adding new ones — the recommended fix is to filter by a per-test install-root name rather than a shared `dorkos-install-*` prefix.

## 15. Marketplace UI (Core Extension)

The Marketplace browse experience ships as a core extension named `marketplace`. On server startup `ensureCoreExtensions()` (in `apps/server/src/services/core-extensions/ensure-core-extensions.ts`, mirroring `ensureDorkBot`) scans the core-extension source tree and copies each extension — Marketplace's source lives at `apps/server/src/core-extensions/marketplace/` — into `{dorkHome}/extensions/<id>/`. The standard `extensionManager.initialize()` discovery pass then picks up the staged directory — the helper does not call `ExtensionManager` directly. Production builds rely on `apps/server/package.json`'s `build` script copying the full `src/core-extensions/` source tree to `dist/core-extensions/`, including the `.ts` files: core-extension source is compiled at runtime by esbuild (like any user extension), not by the server's tsc, so the TypeScript sources must be present at runtime.

The manifest at `apps/server/src/core-extensions/marketplace/extension.json` is parsed against `ExtensionManifestSchema` from `@dorkos/shared` like every other extension. It does **not** have `builtin`, `entry`, or `slots` fields — those don't exist on the schema. `contributions: Record<string, boolean>` is a discoverability hint only; the real registration happens at runtime inside the extension's `activate(api)` function via `api.registerComponent('dashboard.sections', id, Component, { priority })`.

### Layers

The Marketplace UI follows the standard FSD layout under `apps/client/src/`:

- `layers/entities/marketplace/` — TanStack Query hooks (list, detail, permission preview, install, uninstall, update, sources) plus the `marketplaceKeys` cache-key factory in `api/query-keys.ts`.
- `layers/features/marketplace/` — UI components: `Marketplace`, `PackageGrid`, `PackageCard`, `PackageDetailSheet`, `PermissionPreviewSection`, `InstallConfirmationDialog`, `InstalledPackagesView`, `MarketplaceSourcesView`, plus the `useMarketplaceStore` Zustand store under `model/marketplace-store.ts`.
- `layers/widgets/marketplace/` — Page shells (`MarketplacePage`, `MarketplaceSourcesPage`).
- `layers/shared/lib/transport/marketplace-methods.ts` — `marketplaceMethods` factory wired into `HttpTransport`.
- `packages/shared/src/marketplace-schemas.ts` — shared types (`AggregatedPackage`, `MarketplacePackageDetail`, `PermissionPreview`, etc.) consumed by both client and server.

Always import from the layer barrels (`index.ts`), never internal paths — the FSD lint rules apply here too.

### UI state

`useMarketplaceStore` owns purely-local UI state: active filters, the open detail package, and the install confirmation package. Server state lives in TanStack Query keyed off `marketplaceKeys.*`:

- `marketplaceKeys.list(filter)` — aggregated package list.
- `marketplaceKeys.detail(name)` — single package detail.
- `marketplaceKeys.permissionPreview(name)` — permission preview for a target package.
- `marketplaceKeys.installed()` — currently installed packages.
- `marketplaceKeys.sources()` — configured marketplace sources.

Install, uninstall, update, add-source, and remove-source mutations invalidate the appropriate keys on success. See `contributing/state-management.md` for the broader Zustand-vs-TanStack-Query rationale.

### Testing Marketplace

Marketplace UI tests mock `marketplaceMethods` at the hook level via the mock `Transport`, so they never reach the server-side install flow at all. Even a test that grows past hook-level mocking to drive the real install flow through the Transport carries no worktree hazard: the file-scoped transaction engine (section 5, ADR-0304) writes only to the install target and a temp staging dir, never to `process.cwd()`. Point any such integration test at a temp `dorkHome` so it does not mutate the real one.

## 16. Cross-scope install visibility

A package installs to one of two scopes: **global** (`${dorkHome}/<root>/<name>/`, active for every session) or **agent-local** (`${projectPath}/.dork/<root>/<name>/`, active only for sessions whose cwd is that agent's project directory). Both scopes hold the same set of install roots, resolved by `installRootsUnder(scopeRoot)`: a plugin or skill-pack lands in `plugins/`, an agent in `agents/`. The install flow accepts `projectPath` on every mutation (section 10) and has always written agent-local installs correctly. What this section covers is the two things that turn a scoped install from "files on disk" into "visible and running": the cross-scope scan and per-cwd activation.

### The scan model: one entry per installation

`scanInstalledPackages(dorkHome, projectPath?)` in `services/marketplace/installed-scanner.ts` still backs the single-project cases: with no `projectPath` it returns the global roots tagged `scope: 'global'`; with a `projectPath` it returns the **merged** view for that one project (global packages, plus the project's local installs overriding same-named globals in the same install root — one entry per `installKey(kind, name)`, not one per name). The merged view is what the install dialog reads to decide whether a given scope already has the package, i.e. whether the action is an install or a reinstall. It can therefore return two entries sharing a name — a global `plugins/foo` and a project `agents/foo` — because those are two different packages, and the dialog's reinstall question has a different answer for each.

`scanInstallationsAcrossScopes(dorkHome, agents)` is the new discovery path. It walks the global roots **and** every install root under each registered agent's `<projectPath>/.dork/`, and returns **one entry per installation** rather than one per name: a package installed globally and on two agents yields three entries. Each agent entry carries `agentPath` plus the registry's `agentId`/`agentName` (so consumers never re-derive a display name from a path), and is tagged:

- `agent-local` — the package exists only on that agent, or
- `override` — the same package name is also installed globally **in the same install root**, so the agent's copy shadows the global one for that agent's sessions (the same shadowing semantics as the merged view's `override`).

Shadowing keys on `installKey(kind, name)` — the install root's scope-relative name plus the package name — in every one of the three walks (this scan, the merged view, and the update flow). Keying on the name alone would let a project's `agents/flow` shadow a global `plugins/flow`, which are two different packages the conflict detector allows to coexist; keying on the absolute directory would never match anything, since project and global paths always differ.

Every project-scope walk here used to hardcode `plugins/`, so a project-scoped agent — which `AgentInstallFlow` really does write to `<projectPath>/.dork/agents/<name>` — was invisible to all three endpoints and could not be uninstalled (DOR-994, the remainder of DOR-992's update-flow fix).

Ordering is deterministic: global entries first (scan order), then agent entries sorted by agent name. Agents sharing a `projectPath` are deduped; unreadable agent directories are skipped silently, exactly like the global walk. The `agents` argument is supplied by the router as `listAgentScopes()`, wired in `apps/server/src/index.ts` to `meshCore.listWithPaths()` (mapping each agent to `{ projectPath, id, name: displayName ?? name }`) and resolved per request so a just-registered agent is scanned on the next call. The scan is bounded and observable: one readdir plus two small JSON reads per registered agent, kept off the SDK-activation path.

### The API

- `GET /api/marketplace/installed` with **no** `projectPath` returns the cross-scope list (`scanInstallationsAcrossScopes`). With `?projectPath=<path>` it returns the merged single-project view (`scanInstalledPackages`, boundary-validated) — the shape the install dialog needs for reinstall detection.
- `GET /api/marketplace/installed/:name` returns `{ installations: InstalledPackage[] }` — every installation of that one package across scopes, each enriched with a `provides` capability count (`commands`/`skills`/`hooks`) via `computeProvides`. Enrichment lives here, not on the list endpoint, so the marketplace grid never pays N filesystem walks per render; here N is the handful of scopes one package occupies. `404` when the package is installed nowhere.

`GET /installed/:name` returning a **list** (not a single `package`) is a deliberate clean break — every consumer is in-repo. The transport method is `listPackageInstallations(name): Promise<InstalledPackage[]>` (`layers/shared/lib/transport/marketplace-methods.ts`), consumed by the `usePackageInstallations(name)` entity hook.

### Making a scoped install run: harness projection (ADR 260706-192819, superseding the ADR-0305 mechanism)

Visibility is only half the fix; an installed plugin also has to run. ADR-0305 originally solved this inside the SDK: a per-cwd merge (`buildPluginsForCwd`) injected `<cwd>/.dork/plugins/*` into the SDK `options.plugins` array per session. That made scoped installs run inside DorkOS sessions but left the external `claude` CLI blind to them, so it was replaced ([ADR 260706-192819](../decisions/260706-192819-harness-native-plugin-delivery.md)).

Today, project-scoped installs are delivered by **harness projection**, not SDK injection: the Harness Sync engine writes the plugin's commands, skills, and hooks as native files (`.claude/commands/<pkg>/` wrappers, `.claude/skills/<pkg>__*` symlinks, managed hooks in `.claude/settings.local.json`) that the external `claude` CLI and DorkOS sessions both read (DorkOS sessions run with `settingSources: ['local', 'project', 'user']`). See [harness-sync.md](harness-sync.md) §4 for the projection matrix and invariants. The runtime (`claude-code-runtime.ts`) passes only the GLOBAL activated set (`activatedPlugins`, built by `buildClaudeAgentSdkPluginsArray` from `<dorkHome>/plugins/`) to the SDK; global installs keep SDK injection as a transitional exception until global-scope projection lands (DOR-174).

Command propagation after a scoped install/uninstall: `refreshActivatedPlugins(changedProjectPath?)`, fired by `onPluginsChanged` in `index.ts`, reloads commands for live sessions and drops that cwd's cached SDK command list (`RuntimeCache.clearSdkCommands`), while GAP-4 auto-projection rewrites the projected files; the palette then re-reads `.claude/commands/` through the filesystem registry. When a command surfaces from both the SDK cache (a global install) and the filesystem scan (a projected wrapper), the merge in `RuntimeCache.getCommands` dedupes by full command name with the SDK entry winning.

### What is deliberately not solved here

- **Other external harnesses' commands.** Projection gives the external `claude` CLI full command/skill/hook parity, and OpenCode gets flat wrappers. Nothing writes into Cursor's `.cursor/commands/`, Gemini CLI's `.gemini/commands/` or Copilot's `.github/prompts/` yet, so a plugin's commands drop for those three — with a reason naming the format they do have, rather than denying it exists (DOR-1847). Codex is the one harness with genuinely nowhere to put them: its custom prompts were deprecated in favour of skills. Skills and hooks do project to Codex.
- **Unregistered agents.** The cross-scope scan walks only _registered_ agents. An install left under an unregistered directory is invisible to the scan by design; surfacing it moves to agent-unregistration time (spec Phase 2.3), not directory discovery.
- **Extension enable state.** Extension enable/disable is global — it has no per-agent dimension. Installing an extension-bearing package to a single agent still affects every agent; the conflict detector _warns_ at agent scope (spec Phase 2.4) rather than pretending the scoping is real.

See spec `specs/marketplace-scoped-install-visibility/02-specification.md` and ADR-0305 / ADR-0306 for the full rationale and the rejected alternatives (client-side fan-out, a DB-backed install registry, registry-driven activation).
