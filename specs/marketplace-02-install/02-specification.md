---
slug: marketplace-02-install
number: 225
created: 2026-04-06
status: specified
parent-spec: dorkos-marketplace
project: dorkos-marketplace
sequence: 2
depends-on: [marketplace-01-foundation]
depended-on-by: [marketplace-03-extension, marketplace-05-agent-installer]
linear-issue: null
---

# Marketplace 02: Install — Technical Specification

**Slug:** marketplace-02-install
**Author:** Claude Code
**Date:** 2026-04-06
**Project:** DorkOS Marketplace (5 specs total)
**Sequence:** 2 of 5

---

## Overview

This specification defines the install machinery for the DorkOS Marketplace: the `dorkos install` CLI command, the four install flows (plugin/agent/skill-pack/adapter), atomic transactions with rollback, permission preview, uninstall, update notifications, local cache, marketplace source management, and the HTTP API endpoints that the Marketplace Extension UI (spec 03) will call.

After this spec ships, a developer can run `dorkos install code-review-suite@dorkos-community` and get a working installation. The browse UI is still missing — that's spec 03 — but the install half of the marketplace is functional end-to-end via CLI.

### Why

The foundation spec (01) gives us schemas, parsers, and validators. None of that is useful until something actually puts files on disk in the right places, manages lifecycle, and rolls back on failure. This spec is the operational core of the marketplace. Spec 03 (UI) and spec 05 (MCP) will both be thin clients of the install API defined here.

### Source Documents

- `specs/marketplace-02-install/01-ideation.md` — This spec's ideation
- `specs/dorkos-marketplace/01-ideation.md` — Parent project ideation
- `specs/marketplace-01-foundation/02-specification.md` — Foundation (must ship first)
- `apps/server/src/services/core/template-downloader.ts` — Reference: existing git clone + giget + atomic-rollback patterns
- `apps/server/src/services/extensions/extension-manager.ts` — Reference: extension lifecycle pattern
- `apps/server/src/services/relay/adapter-manager.ts` — Reference: adapters.json mutation pattern

---

## Goals

- Implement `dorkos install`, `uninstall`, `update`, `marketplace add/remove/list` CLI subcommands
- Implement four install flows with proper destination handling
- Implement atomic transactions: stage → validate → activate → cleanup or rollback
- Implement permission preview that shows extensions, tasks, secrets, external hosts
- Implement local cache with TTL for marketplace.json and content-addressable storage for clones
- Implement marketplace source management (`~/.dork/marketplaces.json`)
- Implement HTTP API endpoints under `/api/marketplace/*`
- Implement conflict detection across all install flows
- Reuse existing template-downloader, extension-compiler, task-store, mesh-core, adapter-manager
- Achieve full Vitest coverage including failure-path rollback tests

## Non-Goals

- **Browse / search UI** — Spec 03
- **Web marketplace page** — Spec 04
- **Public registry** — Spec 04
- **MCP server** — Spec 05
- **Personal marketplace publishing** — Spec 05
- **Live preview / sandbox** — Deferred
- **Verified publisher signatures** — Deferred
- **Recommendation engine** — Deferred
- **Telemetry** — Spec 04

---

## Technical Dependencies

| Dependency            | Version       | Purpose                                   |
| --------------------- | ------------- | ----------------------------------------- |
| `@dorkos/marketplace` | `workspace:*` | Schemas, parser, validator (from spec 01) |
| `@dorkos/skills`      | `workspace:*` | SKILL.md parsing & validation             |
| `@dorkos/shared`      | `workspace:*` | Shared types, transport interface         |
| `gray-matter`         | `^4.0.3`      | YAML frontmatter parsing                  |
| `zod`                 | `^3.25.76`    | Schema validation                         |
| `express`             | (existing)    | HTTP API endpoints                        |

Reuses these existing services without modification:

- `template-downloader.ts` — Git clone + giget fallback (extended for non-template repos)
- `extension-compiler.ts` — esbuild compilation for installed extension code
- `extension-manager.ts` — Extension lifecycle hooks
- `task-file-watcher.ts` + `task-reconciler.ts` — Auto-syncs installed task files
- `agent-creator.ts` — Reused for agent install flow
- `adapter-manager.ts` — Adapters.json mutation
- `mesh-core.ts` — Mesh registration for installed agents

---

## Detailed Design

### Architecture

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
│   3. Validate package via @dorkos/marketplace.validatePackage()   │
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

### Server Module Layout

```
apps/server/src/services/marketplace/
├── marketplace-installer.ts          # Top-level orchestrator
├── marketplace-source-manager.ts     # ~/.dork/marketplaces.json CRUD
├── marketplace-cache.ts              # ~/.dork/cache/marketplace/ with TTL
├── package-resolver.ts               # name@source → git URL
├── permission-preview.ts             # Build human-readable preview
├── conflict-detector.ts              # Detect slot/skill/task collisions
├── transaction.ts                    # Stage → activate → rollback
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
│   ├── flows/install-plugin.test.ts
│   ├── flows/install-agent.test.ts
│   ├── flows/install-skill-pack.test.ts
│   ├── flows/install-adapter.test.ts
│   ├── flows/uninstall.test.ts
│   └── flows/update.test.ts
└── fixtures/
    └── (sample packages used by integration tests)
```

### Core Types

```typescript
// apps/server/src/services/marketplace/types.ts
import type { MarketplacePackageManifest, PackageType } from '@dorkos/marketplace';

export interface MarketplaceSource {
  /** User-chosen identifier (e.g., "dorkos-community") */
  name: string;
  /** Git URL or marketplace JSON URL */
  source: string;
  /** Whether this source is enabled */
  enabled: boolean;
  /** When this source was added */
  addedAt: string;
}

export interface InstallRequest {
  /** Package name to install */
  name: string;
  /** Optional marketplace identifier (e.g., "dorkos-community") */
  marketplace?: string;
  /** Optional explicit source (overrides marketplace lookup) */
  source?: string;
  /** Force reinstall even if same version is present */
  force?: boolean;
  /** Skip permission preview confirmation (for non-interactive use) */
  yes?: boolean;
  /** Project path for project-local installs (defaults to global) */
  projectPath?: string;
}

export interface PermissionPreview {
  /** What will be created on disk */
  fileChanges: { path: string; action: 'create' | 'modify' | 'delete' }[];
  /** Extensions that will be registered */
  extensions: { id: string; slots: string[] }[];
  /** Tasks that will be created */
  tasks: { name: string; cron: string | null }[];
  /** Secrets the package will request */
  secrets: { key: string; required: boolean; description?: string }[];
  /** External hosts the package will contact */
  externalHosts: string[];
  /** Other packages this depends on */
  requires: { type: string; name: string; version?: string; satisfied: boolean }[];
  /** Conflicts with already-installed packages */
  conflicts: ConflictReport[];
}

export interface ConflictReport {
  level: 'error' | 'warning';
  type: 'slot' | 'skill-name' | 'task-name' | 'cron-collision' | 'adapter-id';
  description: string;
  conflictingPackage?: string;
}

export interface InstallResult {
  ok: boolean;
  packageName: string;
  version: string;
  type: PackageType;
  installPath: string;
  manifest: MarketplacePackageManifest;
  rollbackBranch?: string;
  warnings: string[];
}
```

### `~/.dork/marketplaces.json`

```json
{
  "version": 1,
  "sources": [
    {
      "name": "dorkos-community",
      "source": "https://github.com/dorkos/marketplace",
      "enabled": true,
      "addedAt": "2026-04-06T12:00:00Z"
    },
    {
      "name": "claude-plugins-official",
      "source": "https://github.com/anthropics/claude-plugins-official",
      "enabled": true,
      "addedAt": "2026-04-06T12:00:00Z"
    }
  ]
}
```

`dorkos-community` is seeded by default on first run. Users can add/remove via CLI or marketplace UI (spec 03).

### Local Cache Layout

```
~/.dork/cache/marketplace/
├── marketplaces/
│   └── dorkos-community/
│       ├── marketplace.json           # Last fetched (1h TTL)
│       └── .last-fetched               # Timestamp
└── packages/
    ├── code-review-suite@a3f4b21/      # Content-addressable by commit SHA
    │   └── (cloned package)
    └── code-review-suite@b8c1d99/
        └── (cloned package)
```

**TTL strategy:**

- `marketplace.json`: 1 hour. After expiry, refetch in background, serve stale on failure.
- Cloned packages: Never expire. Garbage-collected only on explicit `dorkos cache prune`.

### Install Flows

#### Plugin Flow

```typescript
async function installPlugin(
  packagePath: string,
  manifest: PluginPackageManifest,
  opts: InstallRequest
): Promise<InstallResult> {
  const installRoot = opts.projectPath
    ? path.join(opts.projectPath, '.dork/plugins', manifest.name)
    : path.join(dorkHome, 'plugins', manifest.name);

  return runTransaction({
    name: `install-plugin:${manifest.name}`,
    rollbackBranch: true,
    async stage(staging) {
      // Copy package contents to staging
      await fs.cp(packagePath, staging.path, { recursive: true });

      // Compile any extensions inside .dork/extensions/
      const extDir = path.join(staging.path, '.dork/extensions');
      if (await exists(extDir)) {
        for (const ext of await fs.readdir(extDir)) {
          await extensionCompiler.compile(path.join(extDir, ext));
        }
      }
    },
    async activate(staging) {
      // Atomic rename: staging → installRoot
      await fs.rename(staging.path, installRoot);

      // Register extensions
      const extDir = path.join(installRoot, '.dork/extensions');
      if (await exists(extDir)) {
        for (const extId of await fs.readdir(extDir)) {
          await extensionManager.enable(extId);
        }
      }

      // Tasks are auto-discovered by task-file-watcher (no explicit registration)
      // Skills are auto-discovered by Claude Code

      return { installPath: installRoot };
    },
  });
}
```

#### Agent Flow

```typescript
async function installAgent(
  packagePath: string,
  manifest: AgentPackageManifest,
  opts: InstallRequest
): Promise<InstallResult> {
  // Use existing agent-creator with the cloned package as the template source
  const targetDir = opts.projectPath ?? path.join(dorkHome, 'agents', manifest.name);

  return runTransaction({
    name: `install-agent:${manifest.name}`,
    rollbackBranch: true,
    async stage(staging) {
      // Copy package contents (template files) to staging
      await fs.cp(packagePath, staging.path, { recursive: true });

      // Apply agentDefaults from manifest
      if (manifest.agentDefaults) {
        // Pre-populate agent.json with defaults
        // (existing agent-creator handles the rest)
      }
    },
    async activate(staging) {
      // Atomic rename
      await fs.rename(staging.path, targetDir);

      // Use existing agent-creator pipeline to scaffold .dork/agent.json,
      // SOUL.md, NOPE.md (it's idempotent, won't overwrite if already present)
      await agentCreator.createAgentWorkspace({
        directory: targetDir,
        name: manifest.name,
        skipTemplateDownload: true, // We already have the template
        traits: manifest.agentDefaults?.traits,
      });

      // Mesh registration happens via mesh-core's reconciler

      return { installPath: targetDir };
    },
  });
}
```

#### Skill Pack Flow

```typescript
async function installSkillPack(
  packagePath: string,
  manifest: SkillPackPackageManifest,
  opts: InstallRequest
): Promise<InstallResult> {
  const installRoot = opts.projectPath
    ? path.join(opts.projectPath, '.dork/plugins', manifest.name)
    : path.join(dorkHome, 'plugins', manifest.name);

  return runTransaction({
    name: `install-skill-pack:${manifest.name}`,
    rollbackBranch: true,
    async stage(staging) {
      await fs.cp(packagePath, staging.path, { recursive: true });
      // Validate every SKILL.md via @dorkos/skills
      // (already done in validatePackage, but we re-verify after copy)
    },
    async activate(staging) {
      await fs.rename(staging.path, installRoot);
      // Skills are auto-discovered by Claude Code
      // Tasks are auto-discovered by task-file-watcher
      return { installPath: installRoot };
    },
  });
}
```

#### Adapter Flow

```typescript
async function installAdapter(
  packagePath: string,
  manifest: AdapterPackageManifest,
  opts: InstallRequest
): Promise<InstallResult> {
  return runTransaction({
    name: `install-adapter:${manifest.name}`,
    rollbackBranch: false, // adapters.json edit is reversible without git
    async stage(staging) {
      // Copy adapter code to staging
      await fs.cp(packagePath, staging.path, { recursive: true });
    },
    async activate(staging) {
      const installPath = path.join(dorkHome, 'plugins', manifest.name);
      await fs.rename(staging.path, installPath);

      // Edit adapters.json to add the new adapter
      // (adapter-manager picks up the change via its file watcher)
      await adapterManager.addAdapter({
        type: manifest.adapterType,
        id: manifest.name,
        config: {}, // User configures secrets after install
        plugin: { path: path.join(installPath, '.dork/adapters', manifest.adapterType) },
      });

      return { installPath };
    },
  });
}
```

### Transaction Engine

```typescript
// apps/server/src/services/marketplace/transaction.ts
export interface TransactionOptions<T> {
  name: string;
  rollbackBranch: boolean;
  stage: (staging: { path: string }) => Promise<void>;
  activate: (staging: { path: string }) => Promise<T>;
}

export async function runTransaction<T>(
  opts: TransactionOptions<T>
): Promise<T & { rollbackBranch?: string }> {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), `dorkos-install-${opts.name}-`));
  let backupBranch: string | undefined;

  try {
    // Optional: create a git rollback branch in the user's project (mirrors template-downloader pattern)
    if (opts.rollbackBranch) {
      backupBranch = await createBackupBranch(opts.name);
    }

    // Stage
    await opts.stage({ path: stagingDir });

    // Activate
    const result = await opts.activate({ path: stagingDir });

    // Cleanup staging on success
    await fs.rm(stagingDir, { recursive: true, force: true });

    return { ...result, rollbackBranch: backupBranch };
  } catch (err) {
    // Rollback: clean staging, restore from backup branch if applicable
    await fs.rm(stagingDir, { recursive: true, force: true });
    if (backupBranch) {
      await rollbackToBranch(backupBranch);
    }
    throw err;
  }
}
```

### Permission Preview Builder

```typescript
// apps/server/src/services/marketplace/permission-preview.ts
export async function buildPermissionPreview(
  packagePath: string,
  manifest: MarketplacePackageManifest
): Promise<PermissionPreview> {
  const preview: PermissionPreview = {
    fileChanges: [],
    extensions: [],
    tasks: [],
    secrets: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
  };

  // Walk the package directory and infer file changes by destination type
  // Read .claude-plugin/plugin.json for declared skills/hooks/MCP servers
  // Read .dork/extensions/*/extension.json for slot registrations + secret declarations
  // Read .dork/tasks/*/SKILL.md for task definitions
  // Read .dork/adapters/*/manifest.json for adapter requirements
  // Resolve `requires` against installed packages
  // Run conflict detector against current state

  return preview;
}
```

### Conflict Detector

Detects collisions across:

- **UI slot contributions** — two packages registering same component in same slot at same priority
- **Skill names** — two skills with the same `name` field at the same scope (project vs global)
- **Task names** — two tasks with the same `name` field at the same scope
- **Cron collisions** — two tasks with overlapping cron windows on the same agent (warning)
- **Adapter IDs** — duplicate `id` in adapters.json
- **Package name collisions** — package already installed at same scope

Returns `ConflictReport[]` with severity levels. Errors block install unless `--force`. Warnings are surfaced in the preview but don't block.

### CLI Commands

```bash
# Install
dorkos install <name>                    # Latest from any configured marketplace
dorkos install <name>@<marketplace>      # Specific marketplace
dorkos install <name>@<source>           # Direct git URL
dorkos install github:user/repo          # Git shorthand
dorkos install ./local/path              # Local directory
dorkos install --type plugin <name>      # Force install flow type (rare)
dorkos install --force <name>            # Override conflict warnings
dorkos install --yes <name>              # Skip confirmation prompt (CI)
dorkos install --project ./apps/web <name>  # Project-local install

# Uninstall
dorkos uninstall <name>                  # Remove package, preserve secrets/data
dorkos uninstall --purge <name>          # Remove everything including data

# Update
dorkos update                            # Notify of all available updates
dorkos update <name>                     # Notify of update for specific package
dorkos update --apply <name>             # Actually update (advisory off)

# Marketplace source management
dorkos marketplace add <url> [--name=<n>]   # Add a marketplace source
dorkos marketplace remove <name>            # Remove a source
dorkos marketplace list                     # List configured sources
dorkos marketplace refresh [<name>]         # Force-refetch marketplace.json

# Cache management
dorkos cache list                        # Show cached packages
dorkos cache prune                       # Garbage-collect old cache entries
dorkos cache clear                       # Wipe entire cache
```

### HTTP API

Mounted at `/api/marketplace/*`:

```
GET    /api/marketplace/sources                       List marketplace sources
POST   /api/marketplace/sources                       Add a source
DELETE /api/marketplace/sources/:name                 Remove a source
POST   /api/marketplace/sources/:name/refresh         Force refetch

GET    /api/marketplace/packages                      List installable packages (aggregated from all sources)
GET    /api/marketplace/packages/:name                Get package details (clones if not cached)
POST   /api/marketplace/packages/:name/preview        Build permission preview without installing
POST   /api/marketplace/packages/:name/install        Install (returns InstallResult)
POST   /api/marketplace/packages/:name/uninstall      Uninstall
POST   /api/marketplace/packages/:name/update         Update (with --apply behavior)

GET    /api/marketplace/installed                     List installed packages
GET    /api/marketplace/installed/:name               Get installed package details

GET    /api/marketplace/cache                         Cache status
DELETE /api/marketplace/cache                         Clear cache
```

All endpoints return JSON. Streaming endpoints (clone progress) use SSE following the existing `discovery/scan` pattern.

### Telemetry Hook (placeholder)

Spec 04 will fully implement telemetry. This spec adds a thin hook so install events can be reported later:

```typescript
// apps/server/src/services/marketplace/telemetry-hook.ts
export interface InstallEvent {
  packageName: string;
  marketplace: string;
  type: PackageType;
  outcome: 'success' | 'failure' | 'cancelled';
  durationMs: number;
  errorCode?: string;
}

export type TelemetryReporter = (event: InstallEvent) => Promise<void>;

let reporter: TelemetryReporter | null = null;

export function registerTelemetryReporter(r: TelemetryReporter) {
  reporter = r;
}

export async function reportInstallEvent(event: InstallEvent) {
  if (!reporter) return;
  try {
    await reporter(event);
  } catch {
    // Telemetry must never fail user operations
  }
}
```

The CLI installer calls `reportInstallEvent` after every install. With no reporter registered (default), it's a no-op. Spec 04 will register a real reporter.

---

## Implementation Phases

### Phase 1 — Core Services

- `marketplace-source-manager.ts` (CRUD on `~/.dork/marketplaces.json`)
- `marketplace-cache.ts` (TTL + content-addressable)
- `package-resolver.ts` (name@source → git URL)
- Tests for all three

### Phase 2 — Permission Preview & Conflict Detection

- `permission-preview.ts`
- `conflict-detector.ts`
- Tests against fixture packages

### Phase 3 — Transaction Engine

- `transaction.ts`
- Failure-path tests (assert rollback works)
- Backup branch integration with template-downloader's existing logic

### Phase 4 — Install Flows

- `flows/install-plugin.ts`, `install-agent.ts`, `install-skill-pack.ts`, `install-adapter.ts`
- Each flow tested in isolation with mocked services
- Integration test that runs end-to-end against a real fixture package

### Phase 5 — Uninstall & Update

- `flows/uninstall.ts`
- `flows/update.ts`
- Idempotency tests, --purge tests

### Phase 6 — HTTP API

- Routes under `apps/server/src/routes/marketplace.ts`
- Wire into main server
- API tests

### Phase 7 — CLI

- Subcommands in `packages/cli/src/commands/`
- Wire into existing CLI entry
- CLI tests

### Phase 8 — Documentation & Polish

- `contributing/marketplace-installs.md` (developer guide)
- Update `CLAUDE.md`
- CHANGELOG entry

---

## Testing Strategy

### Unit Tests

Each service has a `__tests__/*.test.ts` file mocking external dependencies.

### Integration Tests

End-to-end install of fixture packages:

- `valid-plugin/` — Verifies extension compilation, slot registration, file placement
- `valid-agent/` — Verifies agent scaffolding, mesh registration
- `valid-skill-pack/` — Verifies SKILL.md placement and auto-discovery by task watcher
- `valid-adapter/` — Verifies adapters.json mutation and adapter-manager pickup

### Failure-Path Tests

Critical: every install flow must be tested with simulated mid-install failures to assert rollback works:

- Network failure during clone → no partial files
- Validation failure after stage → cleanup
- Activation failure (e.g., extension compile error) → restore from backup branch
- Conflict detection failure → no files written

### Cross-Platform

CI runs the test suite on Linux, macOS, and Windows. Path-handling regressions are caught early.

---

## File Structure

### New files

```
apps/server/src/services/marketplace/
├── (all files listed above)

apps/server/src/routes/
└── marketplace.ts                      # HTTP routes

packages/cli/src/commands/
├── install.ts
├── uninstall.ts
├── update.ts
├── marketplace-add.ts
├── marketplace-remove.ts
├── marketplace-list.ts
└── cache-commands.ts

contributing/
└── marketplace-installs.md             # Developer guide for install internals
```

### Modified files

```
apps/server/src/index.ts                # Wire marketplace routes
packages/cli/src/cli.ts                 # Register new subcommands
CLAUDE.md                               # Add marketplace service domain
CHANGELOG.md                            # Unreleased entry
```

### Unchanged

- `packages/marketplace/` (foundation — consumed but not modified)
- `template-downloader.ts`, `extension-manager.ts`, `task-file-watcher.ts`, `adapter-manager.ts`, `mesh-core.ts`, `agent-creator.ts` (extended via existing APIs)
- Database schemas
- Client code

---

## Acceptance Criteria

- [ ] `dorkos install <name>` works end-to-end for all four package types
- [ ] Permission preview accurately reflects what will be installed
- [ ] Failed installs leave zero residual files on disk (atomic rollback)
- [ ] Backup branches created and respected
- [ ] Conflict detection catches all 5 conflict types listed above
- [ ] Cache hit rate observable and > 80% on repeat operations
- [ ] HTTP API endpoints have OpenAPI documentation
- [ ] `dorkos uninstall` cleanly removes packages
- [ ] `dorkos uninstall --purge` removes data + secrets
- [ ] `dorkos update` notifies (does not auto-apply)
- [ ] `dorkos update --apply` runs the update install
- [ ] Marketplace source management commands work
- [ ] Cross-platform CI passes (Linux/macOS/Windows)
- [ ] All flows have unit + integration + failure-path tests
- [ ] Telemetry hook is in place (no-op until spec 04)
- [ ] Zero changes to existing services beyond their public APIs

---

## Risks & Mitigations

| Risk                                                          | Severity | Mitigation                                                                                 |
| ------------------------------------------------------------- | :------: | ------------------------------------------------------------------------------------------ |
| Mid-install failure leaves partial state                      |   High   | Atomic transactions + backup branches + comprehensive failure-path tests                   |
| Extension compilation slow → poor UX                          |  Medium  | Reuse existing extension-compiler with content-hash cache                                  |
| Conflict detection false positives                            |  Medium  | Distinguish errors from warnings; warnings don't block, only errors require --force        |
| Auth surface broadens (multiple marketplaces)                 |  Medium  | Reuse existing `gh auth token` / `GITHUB_TOKEN` only; no per-marketplace credentials in v1 |
| Cache size growth                                             |   Low    | `dorkos cache prune` removes old content-addressable entries; documented in install guide  |
| Cross-platform path bugs (Windows)                            |  Medium  | CI matrix covers all 3 OSes; existing code already runs cross-platform                     |
| Update flow regressions on existing template downloader users |   Low    | template-downloader.ts is consumed via its existing API only — no changes to its behavior  |
| Reinstall data loss                                           |  Medium  | Reinstalls preserve secrets/data by default; --purge required for full removal             |

---

## Out of Scope (Deferred)

| Item                                  | Spec |
| ------------------------------------- | ---- |
| Browse/search UI                      | 03   |
| Web marketplace                       | 04   |
| Public registry repo                  | 04   |
| Seed packages                         | 04   |
| Telemetry reporter (hook is in place) | 04   |
| MCP server endpoints                  | 05   |
| Personal marketplace publishing       | 05   |
| Live preview                          | v2   |
| Verified publisher signatures         | v2   |

---

## Changelog

### 2026-04-06 — Initial specification

Created from `/ideate-to-spec specs/dorkos-marketplace/01-ideation.md` (batched generation).

This is spec 2 of 5 for the DorkOS Marketplace project.
