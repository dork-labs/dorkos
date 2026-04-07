# Marketplace Installs

The install machinery for the DorkOS Marketplace — how `dorkos install` turns a package name into files on disk, how rollback works when something breaks, and how to add a new install flow without violating the contract every other flow relies on.

Pair this guide with:

- [`specs/marketplace-02-install/02-specification.md`](../specs/marketplace-02-install/02-specification.md) — the authoritative spec. If this guide and the spec disagree, the spec wins and this file needs a patch.
- [`contributing/architecture.md`](architecture.md) — the broader DorkOS hexagonal architecture.
- [ADR-0231](../decisions/0231-atomic-transaction-engine-for-marketplace-installs.md) — why every flow runs through `runTransaction`.
- [ADR-0232](../decisions/0232-content-addressable-marketplace-cache-with-ttl.md) — why `marketplace.json` has a TTL and cloned packages do not.
- [ADR-0233](../decisions/0233-marketplace-update-is-advisory-by-default.md) — why `dorkos update` never mutates disk without `--apply`.

## 1. Overview

A marketplace install turns a short identifier (`code-review-suite@dorkos-community`) into a working installation on disk. The pipeline is deterministic, atomic, and observable: the same seven steps run for every package type, and any failure along the way leaves zero residue.

The four supported package types are `plugin`, `agent`, `skill-pack`, and `adapter`. Each has its own destination rules and activation hook, but they all share the same orchestrator, the same transaction engine, the same permission preview, the same conflict detector, and the same cache layer. If you want to add a fifth type, you write one flow file and plug it into the dispatch switch — everything else is already wired (see section 9).

The install half of the marketplace ships complete via CLI and HTTP. The browse UI is a separate spec; this guide covers only the operational core.

### Key invariants

1. **Nothing touches disk before the permission preview is built.** The user always sees what will change before it changes.
2. **Every flow runs through `runTransaction`.** Failures clean up the staging directory unconditionally. Git-backed flows optionally restore a backup branch.
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
├── marketplace-cache.ts         # ~/.dork/cache/marketplace/ with TTL
├── package-resolver.ts          # name@source → resolved source descriptor
├── package-fetcher.ts           # Git clone + marketplace.json fetch
├── permission-preview.ts        # Build human-readable preview
├── conflict-detector.ts         # Detect slot/skill/task/cron/adapter collisions
├── transaction.ts               # Stage → activate → cleanup/rollback engine
├── telemetry-hook.ts            # Singleton reporter for InstallEvent
├── types.ts                     # Shared types (InstallRequest, PermissionPreview, ...)
├── lib/
│   └── atomic-move.ts           # Cross-device-safe fs.rename replacement
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

Every flow implements the same `install(packagePath, manifest, opts)` method and wraps its work inside `runTransaction`. They differ only in destination rules, what gets compiled or registered during activation, and whether a git rollback branch is worth creating.

### Plugin flow (`flows/install-plugin.ts`)

Destination: `${dorkHome}/plugins/<name>/` (global) or `${projectPath}/.dork/plugins/<name>/` (project-local).

1. **Stage** — Copy the package contents into the staging directory. Walk `.dork/extensions/*/extension.json` and compile each extension via `ExtensionCompiler.compile()`. Any compile failure throws, which drops the staging dir before `activate` runs.
2. **Activate** — `atomicMove(stagingDir, installRoot)`. Re-walk the installed extensions and call `extensionManager.enable(id)` for each. Tasks and skills are picked up automatically by `task-file-watcher` and Claude Code respectively — there is no explicit registration step.

`rollbackBranch: true` because extension compilation can touch tracked files in a repo-local project install.

### Agent flow (`flows/install-agent.ts`)

Destination: `${dorkHome}/agents/<name>/` (global) or `${projectPath}` used directly (project-local).

1. **Stage** — Copy the package contents (template files) into the staging directory. Apply `manifest.agentDefaults` if present.
2. **Activate** — `atomicMove(stagingDir, targetDir)`. Delegate to the existing `createAgentWorkspace()` pipeline with `skipTemplateDownload: true` to scaffold `.dork/agent.json`, `SOUL.md`, and `NOPE.md`. Mesh registration happens implicitly via the mesh-core reconciler — this flow never registers directly.

`rollbackBranch: true`.

### Skill-pack flow (`flows/install-skill-pack.ts`)

Destination: same as plugin — `${dorkHome}/plugins/<name>/` or `${projectPath}/.dork/plugins/<name>/`.

1. **Stage** — Copy the package contents. Re-validate every `SKILL.md` via `@dorkos/skills` (the package validator already ran upstream, but the re-verification catches any mid-install corruption).
2. **Activate** — `atomicMove(stagingDir, installRoot)`. Skills are picked up by Claude Code on next discovery; tasks by `task-file-watcher`. No explicit registration.

`rollbackBranch: true`.

### Adapter flow (`flows/install-adapter.ts`)

Destination: `${dorkHome}/plugins/<name>/` (global only — adapters are never project-local in v1).

1. **Stage** — Copy the package contents into the staging directory.
2. **Activate** — `atomicMove(stagingDir, installPath)`. Call `adapterManager.addAdapter({...})` with the new entry. If registration throws, run a compensating `removeAdapter` call.

`rollbackBranch: false` — the only extra mutation is a single JSON file edit on `relay-adapters.json`, which is reversible without git. Using the git rollback path would be more dangerous than the failure mode (see the hazard in section 5).

### Uninstall flow (`flows/uninstall.ts`)

Removes a previously installed package by name. Plugin/skill-pack/adapter packages live under `${dorkHome}/plugins/<name>/`; agent packages under `${dorkHome}/agents/<name>/`; project-local plugins under `${projectPath}/.dork/plugins/<name>/`.

The flow is rollback-safe without git: the package is moved to a temporary staging directory first, side-effects (extension disable, adapter removal) run against the now-empty location, and only after every step succeeds is the staging directory permanently removed. Any thrown error during the side-effect phase restores the package from staging back to its original install path via `atomicMove`.

**Data preservation.** When `purge: false` (the default), the contents of `<installRoot>/.dork/data/` and `<installRoot>/.dork/secrets.json` are preserved across uninstall + reinstall. With `purge: true`, both paths are removed along with everything else. This is the behaviour that makes the update flow safe (see below).

### Update flow (`flows/update.ts`)

Advisory by default. See [ADR-0233](../decisions/0233-marketplace-update-is-advisory-by-default.md) for the full rationale.

1. Enumerate installed packages (or a single package when called with a name).
2. Look up each one's latest available version in the marketplace catalog via the source manager + fetcher.
3. Compare installed vs latest using `semver.gt()`. Return the comparison.
4. **If and only if `apply: true` was set**, delegate to the injected `InstallerLike.install()` with `force: true`. The installer handles uninstall-without-purge → reinstall, which preserves `.dork/data/` and `.dork/secrets.json` across versions. Every apply runs the full permission preview + conflict detection pipeline — there is no fast path.

The update flow never touches disk on its own. Anything that mutates state lives inside the installer's transaction.

## 5. Transaction lifecycle

One primitive, one file: `services/marketplace/transaction.ts`. Every install, uninstall, and update-apply flow runs through it.

```typescript
runTransaction<T>(opts: {
  name: string;
  rollbackBranch: boolean;
  stage: (staging: { path: string }) => Promise<void>;
  activate: (staging: { path: string }) => Promise<T>;
}): Promise<T & { rollbackBranch?: string }>;
```

Lifecycle:

1. **Create staging dir.** `mkdtemp(path.join(os.tmpdir(), 'dorkos-install-<name>-'))`.
2. **Optional backup branch.** When `rollbackBranch: true` and `process.cwd()` is inside a git working tree, create a uniquely-named branch `dorkos-rollback-<name>-<timestamp>` pointing at the current HEAD. The branch is created via `git branch` — nothing is checked out, so the working tree is unchanged.
3. **Stage.** Call `opts.stage({ path: stagingDir })`. Any thrown error triggers the failure path.
4. **Activate.** Call `opts.activate({ path: stagingDir })`. Any thrown error triggers the failure path.
5. **Success cleanup.** Remove the staging directory. Cleanup errors are logged but never fail the transaction — the install already succeeded; a leftover temp dir is a janitorial concern, not a correctness one.
6. **Failure rollback.** Remove the staging directory first. Then, if a backup branch was created, run `git reset --hard <branch>` in `process.cwd()` to restore the working tree, followed by a best-effort `git branch -D` to delete the temporary branch. The original error is always re-raised.

### Hazard: `git reset --hard` is destructive across the entire worktree

**Read this before writing any test that exercises a flow with `rollbackBranch: true`.** See [ADR-0231](../decisions/0231-atomic-transaction-engine-for-marketplace-installs.md) for the full postmortem.

The git backup branch path uses `execFile('git', ['reset', '--hard', branch], { cwd: process.cwd() })`. In a development worktree this resets every uncommitted tracked-file change in the entire repository — not just the install destination. Session 1 of spec implementation lost additive edits to four unrelated files when failure-path tests legitimately exercised the rollback path against the live worktree.

Consequences for test authors:

**Every Vitest test that exercises `runTransaction({ rollbackBranch: true })` MUST mock `transactionInternal.isGitRepo` to return `false` in `beforeEach`.** Use this pattern verbatim:

```typescript
import { _internal as transactionInternal } from '../transaction.js';

beforeEach(() => {
  vi.spyOn(transactionInternal, 'isGitRepo').mockResolvedValue(false);
});
```

With `isGitRepo` stubbed to `false`, `maybeCreateBackupBranch` short-circuits before the backup branch is ever created, and the destructive `git reset --hard` path becomes unreachable for the duration of the test.

Missing this stub will not produce a test failure — it will silently destroy uncommitted work in the live worktree the first time a failure-path test triggers rollback. The `install-plugin`, `install-agent`, `install-skill-pack`, integration, and failure-path test files already set this up in their shared helpers. New tests that build flows with `rollbackBranch: true` must follow suit.

The `install-adapter` flow deliberately passes `rollbackBranch: false` because the only extra mutation is a single JSON file edit — git rollback would be more dangerous than the failure mode. Uninstall uses its own non-git rollback path for the same reason.

A future hardening pass should redesign the backup branch path to operate against a per-install subtree (e.g. a scratch `git worktree add` or an isolated temp repo) so this test convention is no longer required. Until then, the stub is mandatory.

## 6. Permission preview

Every install is preceded by a `PermissionPreview` — a complete inventory of what the package will do, built before any disk mutation. The full shape (`apps/server/src/services/marketplace/types.ts`):

```typescript
export interface PermissionPreview {
  /** What will be created on disk. */
  fileChanges: { path: string; action: 'create' | 'modify' | 'delete' }[];
  /** Extensions that will be registered. */
  extensions: { id: string; slots: string[] }[];
  /** Tasks that will be created. */
  tasks: { name: string; cron: string | null }[];
  /** Secrets the package will request. */
  secrets: { key: string; required: boolean; description?: string }[];
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
- `.dork/tasks/*/SKILL.md` for task definitions (name + cron).
- `.dork/adapters/*/manifest.json` for adapter requirements.
- The `requires` field on the top-level manifest for dependency resolution against the installed set.

It then delegates to the conflict detector (section 7) and attaches the result to `preview.conflicts`.

The CLI renders the preview to the terminal and prompts for confirmation unless `--yes` is set. The HTTP API returns the preview verbatim via `POST /api/marketplace/packages/:name/preview`, and the marketplace extension UI (spec 03) will render it inside the dialog before the user approves.

## 7. Conflict detection

The conflict detector (`services/marketplace/conflict-detector.ts`) compares a staged package against the active scope (`${dorkHome}/plugins/*`, optionally a project path) and returns a list of `ConflictReport`s. Errors block install unless `--force` is passed. Warnings surface in the preview but never block.

The six collision rules:

| #   | Type             | Severity | Rule                                                                                                                                                                                    |
| --- | ---------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `package-name`   | error    | A directory with the same name already exists under `${scope}/plugins/` or `${scope}/agents/`.                                                                                          |
| 2   | `slot`           | warning  | A staged extension binds the same `slot` + `priority` as an installed extension. Last-installed wins — the detector flags but does not block.                                           |
| 3   | `skill-name`     | error    | A staged `SKILL.md` has the same `name` as an installed one at the same scope. Tasks share this rule because only `SKILL.md` exists today; a separate task manifest is not yet defined. |
| 4   | `cron-collision` | warning  | A staged task's cron expression shares the same minute field as an installed one. Heuristic — no AST parsing in v1.                                                                     |
| 5   | `adapter-id`     | error    | An adapter package's `adapterType` matches an already-configured adapter `id` from `AdapterManager.listAdapters()`.                                                                     |
| 6   | `task-name`      | —        | Folded into rule 3.                                                                                                                                                                     |

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
└── packages/
    ├── code-review-suite@a3f4b21/      # Content-addressable by commit SHA
    │   └── (cloned package)
    └── code-review-suite@b8c1d99/
        └── (cloned package)
```

Two cache disciplines side by side:

- **`marketplace.json` — 1h TTL.** Past the TTL, the cached entry is still served but flagged `stale: true` so the caller can choose to refresh in the background. On network failure, the stale entry is served verbatim — this is the offline fallback.
- **Cloned packages — never expire.** A clone of `code-review-suite@a1b2c3d` is identical today, tomorrow, and a year from now, so TTL would only ever make things worse. Garbage collection is explicit: `dorkos cache prune` (keeps the last N SHAs per package name, default 1) or `dorkos cache clear` (wipes everything).

The cache performs pure file I/O — no network. Callers (source manager, package fetcher) handle the actual upstream fetch and hand the result to `MarketplaceCache.writeMarketplace` / `MarketplaceCache.putPackage`.

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

    const result = await runTransaction<InstallResult>({
      name: `install-theme-${manifest.name}`,
      rollbackBranch: true,
      stage: async (staging) => {
        await cp(packagePath, staging.path, { recursive: true });
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
          warnings: [],
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

**Step 6 — Add a flow test mocking `transactionInternal.isGitRepo`.**

```typescript
import { _internal as transactionInternal } from '../../transaction.js';

beforeEach(() => {
  vi.spyOn(transactionInternal, 'isGitRepo').mockResolvedValue(false);
});
```

This is mandatory for any flow using `rollbackBranch: true`. See section 5.

**Step 7 — Add an integration test.**

Drive the real `MarketplaceInstaller` end-to-end against the new fixture and a temp `dorkHome`. Reuse `buildInstallerForTests` from `integration.test.ts` and assert that the expected files exist after install.

**Step 8 — Add a conflict rule if relevant.**

If the new type introduces its own collision class (e.g. theme IDs must be globally unique), add a new rule and type to `conflict-detector.ts` and extend the `ConflictReport.type` union in `types.ts`.

## 10. HTTP API reference

All endpoints mount under `/api/marketplace/*`. The router factory is `createMarketplaceRouter(deps)` in `apps/server/src/routes/marketplace.ts`. Every response is JSON.

| Method | Path                        | Body                         | Response                                      |
| ------ | --------------------------- | ---------------------------- | --------------------------------------------- |
| GET    | `/sources`                  | —                            | `{ sources: MarketplaceSource[] }`            |
| POST   | `/sources`                  | `{ name, source, enabled? }` | `MarketplaceSource` (201)                     |
| DELETE | `/sources/:name`            | —                            | 204                                           |
| POST   | `/sources/:name/refresh`    | —                            | `{ marketplace: MarketplaceJson, fetchedAt }` |
| GET    | `/installed`                | —                            | `{ packages: InstalledPackage[] }`            |
| GET    | `/installed/:name`          | —                            | `{ package: InstalledPackage }`               |
| GET    | `/cache`                    | —                            | `{ marketplaces, packages, totalSizeBytes }`  |
| DELETE | `/cache`                    | —                            | 204                                           |
| POST   | `/cache/prune`              | `{ keepLastN? }`             | `{ removed: CachedPackage[], freedBytes }`    |
| GET    | `/packages`                 | —                            | `{ packages: AggregatedPackage[] }`           |
| GET    | `/packages/:name`           | `?marketplace=<name>`        | `{ manifest, packagePath, preview }`          |
| POST   | `/packages/:name/preview`   | `InstallRequestBody`         | `{ preview, manifest, packagePath }`          |
| POST   | `/packages/:name/install`   | `InstallRequestBody`         | `InstallResult`                               |
| POST   | `/packages/:name/uninstall` | `{ purge?, projectPath? }`   | `UninstallResult`                             |
| POST   | `/packages/:name/update`    | `{ apply?, projectPath? }`   | `UpdateResult`                                |

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

| Error class                | HTTP status |
| -------------------------- | ----------- |
| `InvalidPackageError`      | 400         |
| `ConflictError`            | 409         |
| `PackageNotInstalledError` | 404         |
| `PackageNotFoundError`     | 404         |
| `MarketplaceNotFoundError` | 404         |
| (anything else)            | 500         |

SSE streaming for clone progress is planned (the spec mentions it following the `discovery/scan` pattern) but deliberately not shipped with this spec — a half-implemented SSE is worse than a unary JSON response that works. A follow-up `POST /packages/:name/install/stream` variant will land in a dedicated task. The current `POST /packages/:name/install` handler has a `// TODO` marker for the wiring point.

The router is mounted in `apps/server/src/index.ts` under the conditional `if (extensionManager && adapterManager)` block — marketplace routes only come up when both the extension subsystem and the adapter manager have initialised, matching how tasks / relay / mesh routes are conditionally mounted.

## 11. CLI command reference

All marketplace CLI subcommands are thin HTTP clients that talk to a running DorkOS server via the API above. Server URL precedence: `DORKOS_PORT` env var → `~/.dork/config.json` → default 4242.

```bash
# Install
dorkos install <name>                         # Latest from any configured marketplace
dorkos install <name>@<marketplace>           # Specific marketplace
dorkos install <name>@<source>                # Direct git URL
dorkos install github:user/repo               # Git shorthand
dorkos install ./local/path                   # Local directory
dorkos install --type plugin <name>           # Force install flow type (rare)
dorkos install --force <name>                 # Override conflict warnings
dorkos install --yes <name>                   # Skip confirmation prompt (CI / non-TTY)
dorkos install --project ./apps/web <name>    # Project-local install

# Uninstall
dorkos uninstall <name>                       # Remove package, preserve secrets/data
dorkos uninstall --purge <name>               # Remove everything including data
dorkos uninstall --project ./apps/web <name>  # Project-local uninstall

# Update
dorkos update                                 # Notify of all available updates
dorkos update <name>                          # Notify of update for specific package
dorkos update --apply <name>                  # Actually update (advisory off)
dorkos update --apply                         # Apply every available update (iterates installed list)

# Marketplace source management
dorkos marketplace add <url> [--name=<n>]     # Add a marketplace source
dorkos marketplace remove <name>              # Remove a source
dorkos marketplace list                       # List configured sources
dorkos marketplace refresh [<name>]           # Force-refetch marketplace.json

# Cache management
dorkos cache list                             # Show cache counts and total size
dorkos cache prune                            # Keep the last SHA per package (default --keep-last-n 1)
dorkos cache prune --keep-last-n <N>          # Keep the last N SHAs per package name
dorkos cache clear -y                         # Wipe the entire cache (requires -y/--yes in non-TTY)
```

`--keep-last-n` on `cache prune` was added during spec implementation — it did not appear in the original spec's CLI block. The endpoint that backs it is `POST /api/marketplace/cache/prune`; `MarketplaceCache.prune({ keepLastN })` is the underlying primitive, defaulting to `keepLastN: 1`.

`dorkos cache clear` requires an explicit `-y`/`--yes` flag in non-interactive mode and prompts interactively otherwise. The confirmation prompt follows the same TTY-aware pattern as `lib/confirm-prompt.ts` used by the install flow.

`dorkos marketplace add <url>` derives a default name from the URL's last path segment (minus `.git`); pass `--name` as the explicit escape hatch. `dorkos marketplace refresh` without a name iterates every configured source via `Promise.allSettled`, so a single failing source never aborts the batch.

`dorkos update` without a package name iterates the installed list client-side — there is no `update-all` endpoint on the server.

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

### Mandatory test setup for flows with `rollbackBranch: true`

Repeating section 5 because this is the single most important convention in the marketplace test suite:

```typescript
import { _internal as transactionInternal } from '../../transaction.js';

beforeEach(() => {
  vi.spyOn(transactionInternal, 'isGitRepo').mockResolvedValue(false);
});
```

Any test that invokes an install flow with `rollbackBranch: true` without this stub will silently destroy uncommitted tracked-file changes in the live worktree the first time its failure path runs. `install-plugin.test.ts`, `install-agent.test.ts`, `install-skill-pack.test.ts`, `integration.test.ts`, and `failure-paths.test.ts` all establish this stub in their shared helpers. New flow tests must follow suit. ADR-0231 has the full context if you want to understand why.

### Failure-path coverage

Every install flow must be tested with simulated mid-install failures to assert rollback works:

- Network failure during clone → no partial files.
- Validation failure after stage → cleanup.
- Activation failure (e.g. extension compile error) → staging dir removed; backup branch restored (via mocked `isGitRepo`).
- Conflict detection error without `--force` → no files written.
- Conflict detection error with `force: true` → install proceeds.

### Fixtures

`services/marketplace/fixtures/` holds one known-good sample per package type (`valid-plugin/`, `valid-agent/`, `valid-skill-pack/`, `valid-adapter/`) plus `broken/*` directories for validation-failure tests. `fixtures.test.ts` sanity-checks the fixtures themselves. When adding a new package type, add a matching fixture and extend `fixtures.test.ts`.

### Running the suites

```bash
pnpm vitest run apps/server/src/services/marketplace   # All marketplace unit + integration tests
pnpm vitest run apps/server/src/routes/__tests__/marketplace.test.ts  # HTTP API
pnpm vitest run packages/cli/src/commands/__tests__    # CLI subcommands
pnpm typecheck                                          # Whole monorepo
pnpm lint                                               # ESLint (including the SDK-import boundary)
```

The full marketplace suite sits at 174+ tests across source + routes + CLI and runs in under a minute on a laptop. Failure-path tests are the slowest because they spin real temp directories, so keep an eye on parallel-run cross-contamination when adding new ones — the recommended fix is to filter by a per-test install-root name rather than a shared `dorkos-install-*` prefix.

## 15. Dork Hub UI (Built-in Extension)

The Dork Hub browse experience ships as a built-in extension named `marketplace`. On server startup `ensureBuiltinMarketplaceExtension()` (in `apps/server/src/services/builtin-extensions/ensure-marketplace.ts`, mirroring `ensureDorkBot`) copies the extension source from `apps/server/src/builtin-extensions/marketplace/` into `{dorkHome}/extensions/marketplace/`. The standard `extensionManager.initialize()` discovery pass then picks up the staged directory — the helper does not call `ExtensionManager` directly. Production builds rely on `apps/server/package.json`'s `build` script post-copying `src/builtin-extensions/` to `dist/builtin-extensions/` (filtering `.ts`) so `extension.json` is present at runtime.

The manifest at `apps/server/src/builtin-extensions/marketplace/extension.json` is parsed against `ExtensionManifestSchema` from `@dorkos/shared` like every other extension. It does **not** have `builtin`, `entry`, or `slots` fields — those don't exist on the schema. `contributions: Record<string, boolean>` is a discoverability hint only; the real registration happens at runtime inside the extension's `activate(api)` function via `api.registerComponent('sidebar.tabs', id, Component, { priority })`.

### Layers

The Dork Hub UI follows the standard FSD layout under `apps/client/src/`:

- `layers/entities/marketplace/` — TanStack Query hooks (list, detail, permission preview, install, uninstall, update, sources) plus the `marketplaceKeys` cache-key factory in `api/query-keys.ts`.
- `layers/features/marketplace/` — UI components: `DorkHub`, `PackageGrid`, `PackageCard`, `PackageDetailSheet`, `PermissionPreviewSection`, `InstallConfirmationDialog`, `InstalledPackagesView`, `MarketplaceSourcesView`, plus the `useDorkHubStore` Zustand store under `model/dork-hub-store.ts`.
- `layers/widgets/marketplace/` — Page shells (`DorkHubPage`, `MarketplaceSourcesPage`).
- `layers/shared/lib/transport/marketplace-methods.ts` — `marketplaceMethods` factory wired into `HttpTransport`.
- `packages/shared/src/marketplace-schemas.ts` — shared types (`AggregatedPackage`, `MarketplacePackageDetail`, `PermissionPreview`, etc.) consumed by both client and server.

Always import from the layer barrels (`index.ts`), never internal paths — the FSD lint rules apply here too.

### UI state

`useDorkHubStore` owns purely-local UI state: active filters, the open detail package, and the install confirmation package. Server state lives in TanStack Query keyed off `marketplaceKeys.*`:

- `marketplaceKeys.list(filter)` — aggregated package list.
- `marketplaceKeys.detail(name)` — single package detail.
- `marketplaceKeys.permissionPreview(name)` — permission preview for a target package.
- `marketplaceKeys.installed()` — currently installed packages.
- `marketplaceKeys.sources()` — configured marketplace sources.

Install, uninstall, update, add-source, and remove-source mutations invalidate the appropriate keys on success. See `contributing/state-management.md` for the broader Zustand-vs-TanStack-Query rationale.

### Testing Dork Hub

Dork Hub UI tests mock `marketplaceMethods` at the hook level via the mock `Transport`, so the server-side `_internal.isGitRepo` rule from section 5 does not apply directly. **The moment a Dork Hub test grows past hook-level mocking and starts driving the real install flow through the Transport, the rule from section 5 applies in full force**: any code path that reaches a flow with `rollbackBranch: true` MUST mock `_internal.isGitRepo` to return false in `beforeEach`, or the failure path will silently `git reset --hard` the live worktree. Re-read section 5 before adding Transport-level Dork Hub integration tests.
