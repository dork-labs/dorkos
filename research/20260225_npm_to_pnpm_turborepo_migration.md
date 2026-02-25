# npm to pnpm Migration Guide for Turborepo Monorepos

**Date:** 2026-02-25
**Scope:** DorkOS monorepo (5 apps, 6 packages, Turborepo 2.x, npm 10.x)
**Research Depth:** Deep

---

## Research Summary

Migrating from npm workspaces to pnpm workspaces in a Turborepo monorepo is well-documented and widely done in 2025. The migration is mechanical and low-risk: the main work is converting the lockfile (`pnpm import`), replacing the `workspaces` field in root `package.json` with a `pnpm-workspace.yaml`, updating the `packageManager` field, converting internal dependency refs to the `workspace:*` protocol, and updating scripts. The single most impactful gotcha for DorkOS specifically is that pnpm's strict dependency isolation may surface phantom dependency issues in packages that implicitly relied on npm's flat hoisting — particularly relevant for the esbuild-based CLI build and `better-sqlite3` native bindings.

---

## Key Findings

### 1. Migration is Mechanical and Low-Risk
The core migration steps are: install pnpm, run `pnpm import` (converts `package-lock.json` → `pnpm-lock.yaml`), delete the old lockfile, create `pnpm-workspace.yaml`, update `package.json`, convert internal `"*"` refs to `"workspace:*"`, and reinstall. No turbo.json changes are required.

### 2. The workspace:* Protocol is a Publishing Safety Net
Unlike npm's workspace refs which are plain version strings, pnpm's `workspace:*` is a typed protocol that:
- Guarantees local resolution during development (never pulls from registry)
- Automatically rewrites to concrete semver versions at publish time
- Makes accidental publishing of local-only refs impossible

### 3. pnpm's Strict Isolation Can Surface Hidden Phantom Dependencies
npm hoists all transitive dependencies to `node_modules/`, making them accidentally accessible. pnpm only links declared direct dependencies into each package's `node_modules/`. Any package in DorkOS that imports a transitive dep without declaring it will break. This must be audited before switching.

### 4. Turborepo Needs No turbo.json Changes
Turborepo detects the package manager from (a) the `packageManager` field in root `package.json`, and (b) the presence of `pnpm-lock.yaml`. No turbo.json modifications are needed for pnpm. The `globalPassThroughEnv` and `env` configurations are package-manager-agnostic.

### 5. dotenv-cli Works the Same Way with pnpm
`dotenv -- pnpm run build` is the direct equivalent of `dotenv -- npm run build`. The existing DorkOS scripts need only `npm run` → `pnpm run` replacements. Turbo's strict env mode behavior is unchanged.

### 6. CLI Package Publishing Needs `prepublishOnly` Updated
`npm run build` in `prepublishOnly` should become `pnpm run build`. The esbuild bundle strategy (externalizing workspace deps, bundling third-party) means pnpm publish works the same as npm publish — the `workspace:*` refs in `packages/cli/package.json` are rewritten to concrete versions at publish time automatically.

---

## Detailed Analysis

### Step-by-Step Migration Process

#### Phase 0: Prerequisites

```bash
# Install pnpm globally
npm install -g pnpm

# Or via corepack (recommended)
corepack enable
corepack prepare pnpm@latest --activate
```

Verify: `pnpm --version`

#### Phase 1: Convert the Lockfile

This is the most important step — it preserves your resolved dependency tree.

```bash
# From the repo root, with package-lock.json present
pnpm import
```

`pnpm import` reads `package-lock.json` (or `npm-shrinkwrap.json` or `yarn.lock`) and generates `pnpm-lock.yaml`. **Critical requirement**: if you have workspaces, you must create `pnpm-workspace.yaml` BEFORE running `pnpm import`, otherwise it only imports the root package.

So the correct order is:
1. Create `pnpm-workspace.yaml` first
2. Then run `pnpm import`
3. Then delete `package-lock.json`

#### Phase 2: Create pnpm-workspace.yaml

Replace the `"workspaces"` field in root `package.json` with this file at the repo root:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

For DorkOS, this maps directly from the existing `"workspaces": ["apps/*", "packages/*"]` in root `package.json`. The root package is always included implicitly.

Additional useful patterns:
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - '!**/node_modules/**'   # exclude node_modules (usually implicit)
  - '!**/test/**'           # exclude test fixture packages
```

The `pnpm-workspace.yaml` also supports a `catalog:` section for pinning shared dependency versions across all packages (new in pnpm 9+):

```yaml
packages:
  - 'apps/*'
  - 'packages/*'

catalog:
  zod: ^4.3.6
  typescript: ^5.7.0
  vitest: ^2.1.0
```

Packages then reference `catalog:` in their `package.json`:
```json
{ "dependencies": { "zod": "catalog:" } }
```
This is optional but eliminates version drift across packages.

#### Phase 3: Update Root package.json

```json
{
  "name": "dorkos",
  "version": "0.3.0",
  "type": "module",
  "private": true,
  "packageManager": "pnpm@10.x.x",
  // REMOVE the "workspaces" field — it lives in pnpm-workspace.yaml now
  "scripts": {
    "dev": "dotenv -- turbo dev",
    "build": "dotenv -- turbo build",
    "test": "dotenv -- turbo test",
    "typecheck": "dotenv -- turbo typecheck",
    "start": "dotenv -- pnpm --filter=@dorkos/server run start",
    "lint": "turbo lint",
    "lint:fix": "turbo lint -- --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "docs:export-api": "dotenv -- tsx scripts/export-openapi.ts",
    "preinstall": "npx only-allow pnpm"
  }
}
```

Key changes:
- `packageManager`: `"npm@10.9.2"` → `"pnpm@10.x.x"` (use your actual installed version)
- Remove `"workspaces"` array (moved to `pnpm-workspace.yaml`)
- `"start"`: `npm run start --workspace=@dorkos/server` → `pnpm --filter=@dorkos/server run start`
- Add `"preinstall": "npx only-allow pnpm"` to prevent accidental npm usage by other contributors

#### Phase 4: Convert Internal Dependency References

All internal workspace package refs in `package.json` files must use `workspace:*` instead of `"*"`.

**Before (npm style):**
```json
{
  "dependencies": { "@dorkos/shared": "*" },
  "devDependencies": {
    "@dorkos/test-utils": "*",
    "@dorkos/typescript-config": "*"
  }
}
```

**After (pnpm style):**
```json
{
  "dependencies": { "@dorkos/shared": "workspace:*" },
  "devDependencies": {
    "@dorkos/test-utils": "workspace:*",
    "@dorkos/typescript-config": "workspace:*"
  }
}
```

Every `apps/*/package.json` and `packages/*/package.json` that references another workspace package needs this update. In DorkOS:

- `apps/server`: `@dorkos/shared: "*"`, `@dorkos/test-utils: "*"`, `@dorkos/typescript-config: "*"` → all become `workspace:*`
- `apps/client`: same pattern
- `apps/web`: same pattern
- `apps/roadmap`: same pattern
- `apps/obsidian-plugin`: same pattern
- `packages/cli`: `@dorkos/typescript-config: "*"` → `workspace:*`
- `packages/test-utils`: any workspace deps → `workspace:*`

#### Phase 5: Install Dependencies

```bash
# Remove old node_modules
rm -rf node_modules apps/*/node_modules packages/*/node_modules

# Install with pnpm
pnpm install
```

pnpm creates a single `pnpm-lock.yaml` at the root (via `sharedWorkspaceLockfile: true`, which is the default). Each package gets its own `node_modules/` with only its declared direct dependencies symlinked in.

#### Phase 6: Update All Scripts and CI

In any `package.json` scripts, replace:
- `npm run X` → `pnpm run X`
- `npm install` → `pnpm install`
- `npm install -w apps/X` → `pnpm add --filter apps/X`
- `npm run X --workspace=@dorkos/Y` → `pnpm --filter=@dorkos/Y run X`

In CI (GitHub Actions, etc.):
```yaml
- uses: pnpm/action-setup@v4
  with:
    version: 10
- uses: actions/setup-node@v4
  with:
    node-version: '22'
    cache: 'pnpm'
- run: pnpm install --frozen-lockfile
```

---

### Key Differences: workspace:* Protocol

| Aspect | npm workspaces | pnpm workspace: |
|--------|----------------|-----------------|
| Syntax | `"dep": "*"` | `"dep": "workspace:*"` |
| Local resolution | Best-effort | Guaranteed (refuses registry) |
| At publish time | Left as-is (can break) | Auto-rewritten to `"1.5.0"` |
| Alias syntax | Not supported | `"bar": "workspace:foo@*"` |
| Range variant `~` | N/A | `workspace:~` → `~1.5.0` at publish |
| Range variant `^` | N/A | `workspace:^` → `^1.5.0` at publish |
| linkWorkspacePackages setting | N/A | `false` (default) means workspace: required |

The `workspace:*` protocol is the safest option for internal packages that are never published standalone. It ensures that `pnpm install` always resolves to the local copy, and `pnpm publish` substitutes the actual version.

---

### pnpm-workspace.yaml Configuration

The full format with all relevant fields:

```yaml
# Required: which directories are workspace packages
packages:
  - 'apps/*'
  - 'packages/*'

# Optional: catalog for shared dependency version pinning (pnpm 9+)
catalog:
  zod: ^4.3.6
  typescript: ^5.7.0

# Optional: named catalogs for different React version sets, etc.
catalogs:
  react18:
    react: ^18.0.0
    react-dom: ^18.0.0
```

Settings that used to go in `.npmrc` now live in `pnpm-workspace.yaml` (pnpm 9+):

```yaml
packages:
  - 'apps/*'
  - 'packages/*'

# Hoisting configuration
shamefullyHoist: false          # Default. true = flat node_modules (npm-like)
publicHoistPattern:             # Hoist specific packages to root node_modules
  - '*eslint*'
  - '*prettier*'

# Peer dependency behavior
autoInstallPeers: true          # Default: installs missing non-optional peers
strictPeerDependencies: false   # Default: warnings only (not errors)
resolvePeersFromWorkspaceRoot: true  # Default: workspace root satisfies peers

# Workspace linking
linkWorkspacePackages: false    # Default: workspace: protocol required
preferWorkspacePackages: false  # Default: registry takes precedence

# Lockfile
sharedWorkspaceLockfile: true   # Default: single lock at root
```

**Note on `.npmrc` vs `pnpm-workspace.yaml`**: In pnpm 9+, workspace/hoisting settings moved to `pnpm-workspace.yaml`. The `.npmrc` file is now primarily for registry auth, proxy, and network settings. The old `.npmrc`-based settings (`shamefully-hoist=true`, `strict-peer-dependencies=false`) still work but are deprecated in favor of `pnpm-workspace.yaml`.

---

### .npmrc Settings for pnpm Monorepos

Create a `.npmrc` at repo root for registry/network settings only:

```ini
# Registry (if using private registry)
# @dorkos:registry=https://registry.example.com

# Network
# https-proxy=http://proxy.example.com

# Auth tokens (better in environment variables)
# //registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

If you need `shamefully-hoist` for tooling compatibility (e.g., certain CLI tools that expect flat `node_modules`), prefer the `pnpm-workspace.yaml` approach:

```yaml
# pnpm-workspace.yaml
shamefullyHoist: true
```

Or surgical hoisting for specific packages only:
```yaml
publicHoistPattern:
  - '*types*'
  - '*eslint*'
```

**Important**: In a monorepo, hoisting is all-or-nothing at the virtual store level (`node_modules/.pnpm`). You cannot hoist for one workspace package and not another.

---

### Turborepo-Specific Considerations

#### No turbo.json Changes Required

Turborepo is package-manager-agnostic in its configuration. The existing `turbo.json` in DorkOS works as-is with pnpm. No schema changes, no pipeline changes.

Turborepo detects pnpm via:
1. `"packageManager": "pnpm@X.Y.Z"` in root `package.json` (primary signal)
2. Presence of `pnpm-lock.yaml` at root (fallback detection)

Both will be true after migration.

#### packageManager Field Format

```json
{
  "packageManager": "pnpm@10.6.5"
}
```

Use your actual installed version: `pnpm --version`. The exact version matters for Corepack enforcement.

#### Turborepo 2.x + pnpm 9 Lockfile Compatibility

There is a known issue with `turbo prune` and pnpm 9's new lockfile format (introduced in pnpm v9). The `turbo prune` command generates a broken `pnpm-lock.yaml` in some cases. If DorkOS uses `turbo prune` for Docker builds or CI pruning, test this carefully after migration. Workarounds include using `--legacy` lockfile format or pinning pnpm 8.x.

For DorkOS's current use (no Docker, no turbo prune in scripts), this is not an immediate concern.

#### globalPassThroughEnv Behavior Unchanged

The existing `turbo.json` configuration is already correct for both npm and pnpm:

```json
{
  "globalPassThroughEnv": ["DORKOS_PORT", "DORK_HOME", ...],
  "tasks": {
    "build": { "env": ["NODE_ENV", "VITE_*", ...] }
  }
}
```

This is entirely package-manager-independent. No changes needed.

---

### Peer Dependency Handling Differences

pnpm's peer dependency handling is more explicit and configurable than npm's:

| Setting | npm default | pnpm default | What it means |
|---------|------------|--------------|---------------|
| Auto-install peers | No | Yes (`autoInstallPeers: true`) | pnpm adds missing peers automatically |
| Strict peer deps | No | No (`strictPeerDependencies: false`) | Mismatches are warnings, not errors |
| Deduplicate peers | N/A | Yes (`dedupePeerDependents: true`) | Avoids multiple instances of peered packages |
| Root resolves peers | N/A | Yes (`resolvePeersFromWorkspaceRoot: true`) | Root `node_modules` satisfies peers for all packages |

**The critical difference**: pnpm creates separate copies of packages that have different peer dependencies resolved. For example, if package A and package B both depend on `some-plugin` but with different versions of `react` as a peer, pnpm installs two copies of `some-plugin`. npm collapses these into one (potentially incorrect).

For DorkOS this primarily matters for:
- `react`/`react-dom` peer deps in UI packages (client, obsidian-plugin)
- Any packages that peer-depend on `typescript` or `vitest`

The `resolvePeersFromWorkspaceRoot: true` default means peer deps are largely satisfied by root-level installs, reducing duplication.

---

### CLI Package Publishing with pnpm

The `packages/cli` package (published as `dorkos` to npm) uses esbuild bundling, so publishing behavior is straightforward:

#### What Stays the Same
- `pnpm publish` works identically to `npm publish` for a standard package
- The `files` field in `package.json` is respected
- The `bin` field works the same way
- The esbuild bundle strategy already externalizes `node_modules` dependencies, so pnpm's isolation model doesn't affect the bundle output

#### What Changes

**In `packages/cli/package.json`:**
```json
{
  "scripts": {
    "build": "tsx scripts/build.ts",
    "prepublishOnly": "pnpm run build"  // was: npm run build
  },
  "devDependencies": {
    "@dorkos/typescript-config": "workspace:*"  // was: "*"
  }
}
```

**Publishing command at root:**
```bash
# Was:
npm publish -w packages/cli

# Becomes:
pnpm publish --filter=dorkos
# or from packages/cli/:
pnpm publish
```

**workspace:* rewrite at publish time**: When `packages/cli` is published, pnpm automatically rewrites any `workspace:*` deps to their concrete semver versions. Since `@dorkos/typescript-config` is a devDependency (not published), this is a non-issue for the CLI.

**Important**: The CLI's `prepublishOnly` currently runs `npm run build`. pnpm does NOT run npm scripts automatically in this context — it must be `pnpm run build`. Update it.

#### Recursive Publishing (if needed)
```bash
# Publish all packages with new versions
pnpm -r publish --access public

# Publish only the CLI
pnpm publish --filter=dorkos --access public
```

---

### dotenv-cli + pnpm Compatibility

The existing DorkOS scripts work without changes to the dotenv invocation pattern. `dotenv -- <command>` is shell-level and agnostic to the package manager.

**Existing scripts that work as-is:**
```json
{
  "dev": "dotenv -- turbo dev",
  "build": "dotenv -- turbo build",
  "test": "dotenv -- turbo test"
}
```

These are called as `pnpm run dev` → runs `dotenv -- turbo dev` in the shell → turbo receives env vars from `.env`. The package manager is not in the call chain for these commands.

**Scripts that need updating (npm workspace syntax):**
```json
{
  // Before:
  "start": "dotenv -- npm run start --workspace=@dorkos/server",
  // After:
  "start": "dotenv -- pnpm --filter=@dorkos/server run start"
}
```

**Known issue to be aware of**: There is a documented interaction between `dotenv-cli` and Turborepo's strict env mode where vars loaded by dotenv-cli are sometimes filtered by Turbo before reaching child processes. This is a Turborepo 2.x issue, not a pnpm issue, and is already documented in `research/20260222_turborepo_env_vars_dotenv_cli.md`. The behavior is identical with pnpm.

**Alternative for monorepo env management**: `@dotenv-run/cli` is a purpose-built alternative to `dotenv-cli` with explicit monorepo support and hierarchical `.env` cascading (Nx, Turbo, pnpm aware). Worth evaluating if dotenv-cli issues persist post-migration.

---

### package-lock.json → pnpm-lock.yaml Migration

```bash
# Step 1: Create pnpm-workspace.yaml FIRST (required for workspaces)
cat > pnpm-workspace.yaml << 'EOF'
packages:
  - 'apps/*'
  - 'packages/*'
EOF

# Step 2: Convert lockfile (reads package-lock.json, writes pnpm-lock.yaml)
pnpm import

# Step 3: Delete old lockfile
rm package-lock.json

# Step 4: Install (validates the new lockfile)
pnpm install
```

**Limitations of `pnpm import`:**
- Supported source formats: `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`
- The import preserves resolved versions but may not preserve all resolution metadata
- After import, run `pnpm install` to validate and ensure the lockfile is clean
- If any packages fail to resolve post-import, delete `pnpm-lock.yaml` and run `pnpm install` fresh — it will resolve from scratch using current registry state

**pnpm-lock.yaml format notes:**
- Single file at repo root (default: `sharedWorkspaceLockfile: true`)
- Human-readable YAML (vs npm's JSON) — better for diffs
- pnpm v9 introduced a new lockfile format (v9) that is not backward-compatible with pnpm v8. Pin your pnpm version via `packageManager` field.

---

### Gotchas and Known Issues

#### 1. Phantom Dependencies (Most Critical)
pnpm's strict isolation means packages can only access their explicitly declared dependencies. If any DorkOS package imports a module that's only present because of npm's hoisting (a transitive dep of another dep), it will fail with `Cannot find module 'X'`.

**Audit approach:**
```bash
# After pnpm install, run the builds and watch for missing module errors
pnpm run build 2>&1 | grep "Cannot find module"

# Use pnpm's built-in tool to find phantom deps
pnpm why <package-name>
```

**Fix**: Add the missing dep explicitly to the package's `package.json`. Do NOT use `shamefullyHoist: true` as a general fix — it re-introduces npm's bad behavior and defeats pnpm's purpose.

#### 2. better-sqlite3 Native Bindings
`better-sqlite3` in `apps/server` uses native Node.js addons. pnpm handles native addons differently — they're linked, not copied. This usually just works, but if you see `Error: Cannot find module '.../better_sqlite3.node'`, you may need to add:

```yaml
# pnpm-workspace.yaml
onlyBuiltDependencies:
  - better-sqlite3
```

Or run `pnpm rebuild better-sqlite3` if the binding isn't found.

#### 3. esbuild in the CLI Build
The CLI build uses esbuild to bundle the server. esbuild itself has a native addon (`esbuild-darwin-arm64`, etc.). pnpm handles platform-specific optional deps correctly via the lockfile's `optionalDependencies` snapshots, but the `pnpm import` step may not capture all platform-specific packages perfectly. Run `pnpm install` and `pnpm run build -w packages/cli` to verify.

#### 4. turbo prune Compatibility
`turbo prune` (used for Docker layer optimization) generates a pruned lockfile. With pnpm 9's new lockfile format, `turbo prune` has a known bug producing malformed `pnpm-lock.yaml`. DorkOS doesn't currently use `turbo prune` in documented scripts, so this is low-priority. If added later, test carefully.

#### 5. Node Linker
pnpm defaults to `nodeLinker: isolated` (the symlink-based approach). If any tool in the chain assumes a flat `node_modules` layout, set:
```yaml
# pnpm-workspace.yaml
nodeLinker: hoisted
```
This gives npm-like behavior while still using pnpm. Only use this as a last resort.

#### 6. scripts referencing `npm`
Search the entire repo for hardcoded `npm` references:
```bash
grep -r '"npm ' apps/ packages/ --include="*.json" -l
grep -r 'npm run\|npm install\|npm publish' . --include="*.ts" --include="*.sh" -l
```

The CLI package's build script (`packages/cli/scripts/build.ts`) may reference npm commands — audit it.

#### 7. pnpm Workspace Filtering Syntax
The filter syntax changes slightly:

| Task | npm | pnpm |
|------|-----|------|
| Run in specific package | `npm run X --workspace=@scope/pkg` | `pnpm --filter=@scope/pkg run X` |
| Run in all packages | `npm run X --workspaces` | `pnpm -r run X` |
| Add dep to specific package | `npm install foo -w apps/server` | `pnpm add foo --filter=@dorkos/server` |
| Add root dep | `npm install foo` | `pnpm add -w foo` (or `pnpm add --workspace-root foo`) |

---

## Complete Migration Checklist for DorkOS

```
Pre-migration:
[ ] Install pnpm (corepack enable && corepack prepare pnpm@latest --activate)
[ ] Note current pnpm version: pnpm --version

Files to create:
[ ] pnpm-workspace.yaml at repo root
[ ] .npmrc at repo root (if needed for registry auth)

Files to modify:
[ ] Root package.json:
    [ ] packageManager: "npm@10.9.2" → "pnpm@X.Y.Z"
    [ ] Remove "workspaces" array
    [ ] "start" script: npm run → pnpm --filter
    [ ] Add "preinstall": "npx only-allow pnpm"
[ ] apps/server/package.json:
    [ ] @dorkos/shared: "*" → "workspace:*"
    [ ] @dorkos/test-utils: "*" → "workspace:*"
    [ ] @dorkos/typescript-config: "*" → "workspace:*"
[ ] apps/client/package.json: same workspace:* conversion
[ ] apps/web/package.json: same workspace:* conversion
[ ] apps/roadmap/package.json: same workspace:* conversion
[ ] apps/obsidian-plugin/package.json: same workspace:* conversion
[ ] packages/cli/package.json:
    [ ] @dorkos/typescript-config: "*" → "workspace:*"
    [ ] prepublishOnly: "npm run build" → "pnpm run build"
[ ] packages/test-utils/package.json: check for workspace deps
[ ] packages/shared/package.json: check for workspace deps
[ ] Any other packages/*/package.json: check for workspace deps

Lockfile migration:
[ ] pnpm import (converts package-lock.json → pnpm-lock.yaml)
[ ] rm package-lock.json
[ ] pnpm install (validate)

Post-migration verification:
[ ] pnpm run build (all packages build)
[ ] pnpm run test (all tests pass)
[ ] pnpm run typecheck (no type errors)
[ ] pnpm run dev (dev servers start)
[ ] pnpm run lint (no lint errors)
[ ] Check for phantom dep errors in build output
[ ] Verify better-sqlite3 native binding resolves
[ ] Test CLI build: pnpm run build -w packages/cli
[ ] Test publishing dry-run: pnpm publish --filter=dorkos --dry-run

CI/CD:
[ ] Update CI scripts to use pnpm
[ ] Add pnpm/action-setup step in GitHub Actions
[ ] Update cache key from package-lock.json → pnpm-lock.yaml
[ ] Update any Docker build steps
```

---

## Sources & Evidence

- [pnpm Workspaces Documentation](https://pnpm.io/workspaces) — workspace: protocol, publishing behavior, linkWorkspacePackages
- [pnpm-workspace.yaml Reference](https://pnpm.io/pnpm-workspace_yaml) — packages glob, catalog syntax
- [pnpm Settings (pnpm-workspace.yaml)](https://pnpm.io/settings) — shamefullyHoist, autoInstallPeers, strictPeerDependencies, resolvePeersFromWorkspaceRoot
- [pnpm import Command](https://pnpm.io/cli/import) — lockfile conversion, workspace requirement
- [pnpm Auth & Registry (.npmrc)](https://pnpm.io/npmrc) — confirms .npmrc is for auth/registry only now
- [pnpm publish CLI](https://pnpm.io/cli/publish) — publishing from monorepos
- [Turborepo Structuring a Repository](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository) — packageManager field, pnpm-workspace.yaml format
- [Turborepo Configuration Reference](https://turborepo.dev/docs/reference/configuration) — globalPassThroughEnv, env, package manager agnosticism
- [How we configured pnpm and Turborepo for our monorepo | Nhost](https://nhost.io/blog/how-we-configured-pnpm-and-turborepo-for-our-monorepo) — real-world turbo.json + pnpm-workspace.yaml example
- [npm to pnpm migration guide | DEV Community](https://dev.to/andreychernykh/yarn-npm-to-pnpm-migration-guide-2n04) — step-by-step migration process
- [Why you shouldn't use npm workspaces | Hashnode](https://edrickleong.hashnode.dev/why-you-shouldnt-use-npm-workspaces) — comparative analysis
- [pnpm 9 lockfile support · vercel/turborepo issue](https://github.com/vercel/turborepo/issues/7993) — turbo prune compatibility issue with pnpm 9
- [turbo prune generates broken pnpm lockfile](https://github.com/vercel/turborepo/issues/3382) — documented turbo prune bug
- [Peer Dependency Resolution | pnpm DeepWiki](https://deepwiki.com/pnpm/pnpm/3.3-peer-dependencies-handling) — peer dep deduplication behavior
- [React Native, pnpm, and Monorepos | DEV Community](https://dev.to/heyradcode/react-native-pnpm-and-monorepos-a-dependency-hoisting-journey-5809) — hoisting in monorepos
- [dotenv-cli env vars not passing through Turborepo](https://github.com/vercel/turborepo/discussions/7056) — known dotenv + turbo issue
- [@dotenv-run/cli](https://www.npmjs.com/package/@dotenv-run/cli) — monorepo-aware dotenv alternative

---

## Research Gaps & Limitations

- **Catalog feature maturity**: The `catalog:` feature in `pnpm-workspace.yaml` is new (pnpm 9.x). Not all tooling fully supports it yet. Turborepo's cache hash behavior with catalog pins is not explicitly documented.
- **turbo prune + pnpm 9 fix status**: The linked GitHub issue was open as of this research. Check issue status before adding `turbo prune` to CI.
- **Obsidian plugin Electron compat**: The obsidian plugin has custom Vite build plugins for Electron compatibility (`safeRequires`, `fixDirnamePolyfill`). pnpm's symlink-based `node_modules` may require testing in Electron context — not researched specifically.
- **@ngrok/ngrok with pnpm**: The ngrok SDK uses optional peer deps and binary downloads. Not explicitly tested with pnpm's isolation model — verify post-migration.

---

## Search Methodology

- Searches performed: 11 web searches + 8 page fetches
- Most productive search terms: "pnpm import", "workspace:* publishing behavior", "pnpm-workspace.yaml settings", "turborepo packageManager field pnpm"
- Primary source types: Official pnpm.io docs, Turborepo docs, real-world migration guides
- DorkOS codebase files read: root `package.json`, `turbo.json`, `apps/server/package.json`, `packages/cli/package.json`, `packages/shared/package.json`, all package paths via glob
