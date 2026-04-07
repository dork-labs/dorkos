# Task Breakdown: Marketplace 05 — Claude Code Format Superset

Generated: 2026-04-07
Source: specs/marketplace-05-claude-code-format-superset/02-specification.md
Last Decompose: 2026-04-07

## Overview

This spec converts the DorkOS marketplace format from an aspirationally "Claude Code-compatible" shape into a strict superset of Claude Code's marketplace format. It fixes 6 known structural incompatibilities in `packages/marketplace/src/marketplace-json-schema.ts` (source discriminated union, `owner`, `metadata`, `author` object shape, `.claude-plugin/` file location, CC component fields), adds a sidecar `dorkos.json` for DorkOS-specific extensions (because CC enforces `additionalProperties: false`), implements 4 of 5 source-type resolvers (npm deferred to marketplace-06), sparse-clones git subdirectories for `git-subdir` sources, ports the CC schema to Zod with a weekly sync cron, activates installed plugins via the Claude Agent SDK `options.plugins` API, rewrites the seed as a same-repo monorepo at `dork-labs/marketplace`, and adds `source_type` telemetry. It ships before #28 deploys so the new seed can be bootstrapped directly with the correct schema. Four ADRs (0236-0239) were auto-extracted during ideation and are finalized in this spec's execution.

The work is broken into 8 batches with holistic batch-level verification gates per the repo's stored feedback (no per-task two-stage review). Total: ~42 tasks across 8 phases.

---

## Batch 1: Schema Foundation

### Task 1.1: Performing empirical Claude Code validator sidecar verification

**Size**: Small
**Priority**: High
**Dependencies**: None
**Files**: `research/20260407_cc_validator_empirical_verify.md`

**Technical Requirements**:

- Load-bearing one-time empirical check against real Claude Code binary
- Blocks all schema work in Phase 1.2+ until the sidecar strategy is confirmed correct

**Implementation Steps**:

1. Install Claude Code locally
2. Create Fixture A (minimal CC marketplace.json, no DorkOS fields)
3. Create Fixture B (same as A + inline `x-dorkos: { type: 'agent' }` on one plugin entry)
4. Run `claude plugin validate` against both
5. Document results, CC version, and conclusion in `research/20260407_cc_validator_empirical_verify.md`

**Acceptance Criteria**:

- [ ] Research file with both commands' raw output and exit codes captured
- [ ] CC version recorded
- [ ] Conclusion paragraph confirms sidecar strategy (or flags blocker)

### Task 1.2: Rewriting marketplace-json-schema with discriminated source union

**Size**: Large
**Priority**: High
**Dependencies**: 1.1
**Files**: `packages/marketplace/src/marketplace-json-schema.ts`

**Technical Requirements**:

- Full rewrite of the current schema file
- Discriminated source union for 5 source forms (relative-path string, github object, url object, git-subdir object, npm object)
- `owner` required at top level
- `author` as object schema (not string)
- `metadata` object with optional `description`/`version`/`pluginRoot`
- `.passthrough()` on top level and plugin entries for forward-compat
- `RESERVED_MARKETPLACE_NAMES` constant with 8 names, enforced via `.refine()`
- Opaque `commands`/`agents`/`hooks`/`mcpServers`/`lspServers` fields
- All DorkOS extension fields REMOVED from this file (they move to the sidecar)
- Browser-safe: zod only, no Node.js imports
- TSDoc on every export

**Acceptance Criteria**:

- [ ] New discriminated source union present
- [ ] `owner` required
- [ ] `author` is object schema
- [ ] `RESERVED_MARKETPLACE_NAMES` exported and enforced
- [ ] DorkOS extension fields removed
- [ ] Per-export TSDoc
- [ ] No Node.js imports

### Task 1.3: Adding dorkos-sidecar-schema for DorkOS extensions

**Size**: Medium
**Priority**: High
**Dependencies**: 1.1
**Parallel with**: 1.2
**Files**: `packages/marketplace/src/dorkos-sidecar-schema.ts` (new)

**Technical Requirements**:

- Create new browser-safe schema file for `.claude-plugin/dorkos.json`
- Exports: `PricingSchema`, `DorkosEntrySchema`, `DorkosSidecarSchema`, + 3 inferred types
- `schemaVersion` is `z.literal(1)` (not `z.number()`)
- `plugins` is `z.record(z.string(), DorkosEntrySchema)` — indexed by plugin name
- `requires` regex: `^(adapter|plugin|skill-pack|agent):[a-z][a-z0-9-]*([@][\w.~^>=<!*-]+)?$`
- `dorkosMinVersion` semver regex
- `pricing.model` enum: `free|paid|freemium|byo-license`

**Acceptance Criteria**:

- [ ] File with all four schemas and three types
- [ ] Module-level TSDoc
- [ ] No Node.js imports
- [ ] `schemaVersion` is literal 1

### Task 1.4: Adding merge-marketplace helper with drift handling

**Size**: Small
**Priority**: High
**Dependencies**: 1.2, 1.3
**Files**: `packages/marketplace/src/merge-marketplace.ts` (new)

**Technical Requirements**:

- Pure helper that merges `MarketplaceJson` + optional `DorkosSidecar` → `MergedMarketplaceEntry[]` + orphans
- `MergedMarketplaceEntry extends MarketplaceJsonEntry` with added `dorkos?: DorkosEntry`
- `MergeMarketplaceResult = { entries, orphans }`
- Drift handling: orphans (in sidecar, not in marketplace) returned for caller to log; dropped from entries
- Missing in sidecar: entry gets `dorkos: undefined` (default plugin, pricing free implicit)
- No logging in this file (caller handles)

**Acceptance Criteria**:

- [ ] Exports `MergedMarketplaceEntry`, `MergeMarketplaceResult`, `mergeMarketplace`
- [ ] Orphan detection covers empty and populated sidecars
- [ ] No Node.js imports

### Task 1.5: Adding source-resolver pure function with pluginRoot semantics

**Size**: Medium
**Priority**: High
**Dependencies**: 1.2
**Parallel with**: 1.3, 1.4
**Files**: `packages/marketplace/src/source-resolver.ts` (new)

**Technical Requirements**:

- Browser-safe pure function interpreting `PluginSource` → `ResolvedSourceDescriptor`
- `ResolvedSourceDescriptor` union with 5 forms (relative-path, github, url, git-subdir, npm)
- `ResolvePluginSourceError` class for errors
- `metadata.pluginRoot` rules:
  1. Bare relative + pluginRoot set → `<root>/<pluginRoot>/<source>`
  2. Explicit `./` → pluginRoot ignored
  3. Trailing slashes normalized
  4. Absolute `pluginRoot` → error
  5. `..` in path → error
  6. Object-form sources ignore pluginRoot entirely
- `github` source → `cloneUrl: 'https://github.com/' + repo + '.git'`
- Pure path string concat only — no Node.js path module

**Acceptance Criteria**:

- [ ] All 6 rules enforced
- [ ] Object-form sources never consult pluginRoot
- [ ] No Node.js imports
- [ ] Per-export TSDoc

### Task 1.6: Porting CC validator to Zod with strict mode

**Size**: Large
**Priority**: High
**Dependencies**: 1.2
**Parallel with**: 1.3, 1.5
**Files**: `packages/marketplace/src/cc-validator.ts` (new)

**Technical Requirements**:

- Second-pass Zod schema mirroring CC's strict validator behavior
- Reference: `hesreallyhim/claude-code-json-schema`
- Uses `.strict()` on plugin entries (mirrors CC's `additionalProperties: false`)
- Sync direction invariant: MUST NOT be stricter than CC's CLI behavior
- Exports: `CcMarketplaceJsonSchema`, `CcMarketplaceJsonEntrySchema`, `validateAgainstCcSchema(raw)`
- `validateAgainstCcSchema` returns `{ ok: true } | { ok: false, errors }`

**Acceptance Criteria**:

- [ ] Strict-mode entry schema
- [ ] Module-level TSDoc explains sync direction invariant
- [ ] Rejects inline `x-dorkos`
- [ ] Accepts minimal valid CC marketplace
- [ ] No Node.js imports

### Task 1.7: Updating marketplace-json-parser and package-validator for sidecar

**Size**: Medium
**Priority**: High
**Dependencies**: 1.4, 1.6
**Files**: `packages/marketplace/src/marketplace-json-parser.ts`, `packages/marketplace/src/package-validator.ts`

**Technical Requirements**:

- Add `parseDorkosSidecar(raw)` and `parseMarketplaceWithSidecar(raw, rawSidecar)`
- `parseMarketplaceWithSidecar` returns `{ merged, marketplace, sidecar, orphans }`
- Add `validateMarketplaceJson(raw)` and `validateMarketplaceJsonWithCcSchema(raw)` in package-validator
- First uses DorkOS passthrough schema; second uses strict CC schema
- Both return arrays of `{ level, message, path? }`

**Acceptance Criteria**:

- [ ] All new exports present with TSDoc
- [ ] Merge result includes orphans
- [ ] Both validators return structured arrays

### Task 1.8: Updating @dorkos/marketplace barrel exports

**Size**: Small
**Priority**: High
**Dependencies**: 1.7
**Files**: `packages/marketplace/src/index.ts`

**Technical Requirements**:

- Re-export all new schemas, types, helpers, resolvers, validators
- Keep existing exports unchanged

**Acceptance Criteria**:

- [ ] `import { MarketplaceJsonSchema } from '@dorkos/marketplace'` resolves to the new schema
- [ ] All new symbols exported
- [ ] `pnpm typecheck --filter @dorkos/marketplace` passes

### Task 1.9: Adding schema unit tests for new shapes

**Size**: Large
**Priority**: High
**Dependencies**: 1.8
**Files**: 5 new test files under `packages/marketplace/src/__tests__/`

**Technical Requirements**:

- `marketplace-json-schema.test.ts`: 5 source forms × valid+invalid, owner, author shape, metadata, reserved names, kebab-case, passthrough for unknown commands
- `dorkos-sidecar-schema.test.ts`: type enum, layers enum, requires regex, pricing shape, dorkosMinVersion semver, schemaVersion literal
- `source-resolver.test.ts`: all 5 types, pluginRoot edge cases, ../absolute rejection, object-form ignores pluginRoot
- `merge-marketplace.test.ts`: both present, sidecar null, orphans, empty states
- `cc-validator.test.ts`: minimal passes, inline `x-dorkos` fails, missing owner fails, reserved name fails, all 5 source forms accepted

**Acceptance Criteria**:

- [ ] All 5 test files exist
- [ ] ≥30 distinct test cases
- [ ] `pnpm vitest run packages/marketplace/src/__tests__` green

### Task 1.10: [BATCH GATE] Verifying schema foundation batch

**Size**: Small
**Priority**: High
**Dependencies**: 1.9

**Commands**: `pnpm typecheck --filter @dorkos/marketplace`, `pnpm lint --filter @dorkos/marketplace`, `pnpm vitest run --filter @dorkos/marketplace`, workspace-level `pnpm typecheck`.

**Acceptance Criteria**:

- [ ] Marketplace package typecheck/lint/test green
- [ ] Workspace typecheck either green or only has Phase-2-scope consumer failures clearly listed

---

## Batch 2: Server Install Pipeline

### Task 2.1: Adding source-resolvers/relative-path resolver

**Size**: Small
**Priority**: High
**Dependencies**: 1.10
**Files**: `apps/server/src/services/marketplace/source-resolvers/relative-path.ts` (new), `__tests__/relative-path.test.ts`

**Technical Requirements**:

- Path join + exists check, no clone
- Returns `commitSha: 'relative-path'` sentinel + `fromCache: true`
- Throws `PackageNotFoundError` if path missing

**Acceptance Criteria**:

- [ ] Exports `relativePathResolver`
- [ ] Tests cover present, missing, sentinel

### Task 2.2: Adding source-resolvers/github resolver

**Size**: Small
**Priority**: High
**Dependencies**: 1.10
**Parallel with**: 2.1
**Files**: `apps/server/src/services/marketplace/source-resolvers/github.ts` (new), tests

**Technical Requirements**:

- Wraps existing `cloneRepository` with object input
- Pin precedence: `sha > ref > 'main'`
- `cloneUrl = 'https://github.com/' + repo + '.git'`

**Acceptance Criteria**:

- [ ] URL construction correct
- [ ] Pin precedence honored

### Task 2.3: Adding source-resolvers/url resolver

**Size**: Small
**Priority**: High
**Dependencies**: 1.10
**Parallel with**: 2.1, 2.2
**Files**: `apps/server/src/services/marketplace/source-resolvers/url.ts` (new), tests

**Technical Requirements**:

- Supports `https://`, `git@`, `.git`-optional URLs
- Same pin precedence as github

**Acceptance Criteria**:

- [ ] Three URL variants accepted
- [ ] Pin precedence honored

### Task 2.4: Adding source-resolvers/git-subdir with sparse-clone fallback ladder

**Size**: Large
**Priority**: High
**Dependencies**: 1.10
**Parallel with**: 2.1, 2.2, 2.3
**Files**: `apps/server/src/services/marketplace/source-resolvers/git-subdir.ts` (new), tests

**Technical Requirements**:

- 4-step sparse-clone: `git clone --filter=blob:none --no-checkout --depth=1`, `git sparse-checkout init --cone`, `git sparse-checkout set <subpath>`, `git checkout <ref>`
- Fallback ladder: partial → shallow → full-clone-with-cleanup
- `isFilterUnsupportedError` and `isSparseCheckoutUnsupportedError` stderr heuristics
- Integration test gated on network (real public GitHub monorepo)

**Acceptance Criteria**:

- [ ] gitSubdirResolver + 3 fallback helpers
- [ ] Mocked unit tests cover happy path + 2 fallbacks + cache hit + SHA pinning
- [ ] Integration test exists

### Task 2.5: Adding source-resolvers/npm stub with structured deferred error

**Size**: Small
**Priority**: High
**Dependencies**: 1.10
**Parallel with**: 2.1-2.4
**Files**: `apps/server/src/services/marketplace/source-resolvers/npm.ts` (new), tests

**Technical Requirements**:

- Throws `NpmSourceNotSupportedError` with `package`, `version`, `docs` fields
- Message references marketplace-06 spec

**Acceptance Criteria**:

- [ ] Error class structured
- [ ] No filesystem or network access

### Task 2.6: Refactoring package-fetcher with source-type dispatch

**Size**: Large
**Priority**: High
**Dependencies**: 2.1, 2.2, 2.3, 2.4, 2.5
**Files**: `apps/server/src/services/marketplace/package-fetcher.ts`, tests

**Technical Requirements**:

- New `fetchPackage(opts)` with source-type switch dispatching to 5 resolvers
- `FetchPackageOptions` includes `packageName`, `source`, `marketplaceRoot`, `pluginRoot`, `force`
- Constructor DI for `FetcherDeps` (cache, logger, cloneRepository, resolveCommitSha)
- `resolveMarketplaceJsonUrl` updated to use `.claude-plugin/marketplace.json`
- New `resolveDorkosSidecarUrl` helper
- `fetchMarketplaceJson` fetches both marketplace and sidecar in parallel
- `fetchFromGit` preserved as deprecated wrapper

**Acceptance Criteria**:

- [ ] Dispatch correct for all 5 source types
- [ ] URL helpers updated to `.claude-plugin/`
- [ ] Sidecar fetched in parallel, 404 → null
- [ ] Deprecated wrapper still works

### Task 2.7: Threading marketplaceRoot/pluginRoot through marketplace-installer and transaction

**Size**: Medium
**Priority**: High
**Dependencies**: 2.6
**Files**: `marketplace-installer.ts`, `transaction.ts`, `marketplace-cache.ts`

**Technical Requirements**:

- Installer passes `marketplaceRoot`, `pluginRoot` to fetchPackage
- `NpmSourceNotSupportedError` caught at orchestrator, surfaced as structured result, does NOT enter transaction
- Cache short-circuits on `'relative-path'` sentinel SHA
- CRITICAL: any test with `rollbackBranch: true` MUST mock `_internal.isGitRepo` to return false (per ADR-0231 and contributing/marketplace-installs.md) to prevent destroying uncommitted tracked files

**Acceptance Criteria**:

- [ ] marketplaceRoot/pluginRoot threaded
- [ ] Npm error caught cleanly
- [ ] Cache sentinel honored
- [ ] All rollback tests mock isGitRepo

### Task 2.8: Adding 4x4 install matrix integration tests

**Size**: Large
**Priority**: High
**Dependencies**: 2.7
**Files**: `apps/server/src/services/marketplace/__tests__/install-source-matrix.test.ts` (new)

**Technical Requirements**:

- 8 test cases: relative-path install, github install, github+SHA, url install, git-subdir, git-subdir with --filter unsupported fallback, npm deferred error, rollback (with isGitRepo mocked false)
- Mock `child_process.spawn` + `node:fs/promises`
- Fake cache + logger
- No real network or filesystem operations

**Acceptance Criteria**:

- [ ] 8 scenarios all green
- [ ] Subprocess call shapes asserted
- [ ] `_internal.isGitRepo` mocked false in beforeEach

### Task 2.9: [BATCH GATE] Verifying server install pipeline batch

**Size**: Small
**Priority**: High
**Dependencies**: 2.8

**Commands**: server typecheck/lint/test filter + workspace typecheck.

**Acceptance Criteria**:

- [ ] Server package green
- [ ] 4×4 install matrix green
- [ ] Workspace typecheck either green or only client/site failures remain

---

## Batch 3: Plugin Runtime Activation

### Task 3.1: Adding plugin-activation builder for Claude Agent SDK

**Size**: Small
**Priority**: High
**Dependencies**: 1.10
**Files**: `apps/server/src/services/runtimes/claude-code/plugin-activation.ts` (new), tests

**Technical Requirements**:

- `buildClaudeAgentSdkPluginsArray({ dorkHome, enabledPluginNames, logger })` returns `[{ type: 'local', path }]`
- Filters missing directories, logs warning
- Path joined via `path.join(dorkHome, 'marketplace', 'packages', name)` — no `os.homedir()`
- Lives inside ESLint boundary (file location qualifies it)

**Acceptance Criteria**:

- [ ] Exports builder
- [ ] 5 test scenarios covered (empty, single, multi, missing, mixed)
- [ ] No `os.homedir()`

### Task 3.2: Adding marketplace-service.getEnabledPlugins method

**Size**: Small
**Priority**: High
**Dependencies**: 2.9
**Parallel with**: 3.1
**Files**: `apps/server/src/services/marketplace/marketplace-service.ts`

**Technical Requirements**:

- Returns `Array<{ name, installPath, sourceType }>`
- Filters by `enabled: true`
- Tests cover empty, all-enabled, mixed

**Acceptance Criteria**:

- [ ] Method exists with documented signature
- [ ] Tests cover edge cases

### Task 3.3: Wiring claude-code-runtime to options.plugins

**Size**: Medium
**Priority**: High
**Dependencies**: 3.1, 3.2
**Files**: `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`, tests

**Technical Requirements**:

- Call `buildClaudeAgentSdkPluginsArray` at session start
- Pass result via `options.plugins` to SDK `query()`
- Empty array when no plugins enabled

**Acceptance Criteria**:

- [ ] `query()` receives `options.plugins`
- [ ] Tests cover 0/1/N plugins
- [ ] No regressions in existing runtime tests

### Task 3.4: [BATCH GATE] Verifying plugin runtime activation batch

**Size**: Small
**Priority**: High
**Dependencies**: 3.3

**Commands**: server typecheck/lint/test filter on runtimes + marketplace services.

**Acceptance Criteria**:

- [ ] All commands green
- [ ] No SDK imports leaked outside `services/runtimes/claude-code/`

---

## Batch 4: Site Fetch and UI

### Task 4.1: Updating site fetch layer for sidecar and new path

**Size**: Medium
**Priority**: High
**Dependencies**: 1.10
**Files**: `apps/site/src/layers/features/marketplace/lib/fetch.ts`, tests

**Technical Requirements**:

- URL constants point to `dork-labs/marketplace` + `.claude-plugin/` paths
- `fetchMarketplaceJson` fetches both marketplace.json and sidecar in parallel
- Sidecar 404 non-fatal → `null`
- Uses `parseMarketplaceWithSidecar` + logs orphans
- `fetchPackageReadme(source)` dispatches per source type (4 git-based + npm returns empty)
- `fetchText` helper returns empty string on any error

**Acceptance Criteria**:

- [ ] URL constants updated
- [ ] Merged + orphans returned
- [ ] Per-type README URL building
- [ ] Sidecar 404 tolerated

### Task 4.2: Updating site marketplace UI components for new shapes

**Size**: Medium
**Priority**: Medium
**Dependencies**: 4.1
**Files**: `PackageHeader.tsx`, `InstallInstructions.tsx`, tests

**Technical Requirements**:

- `PackageHeader` renders `author.name` (object access) + optional email link
- `InstallInstructions` dispatches per source type, shows "coming soon" Alert for npm
- Other components (PackageCard, MarketplaceGrid, etc.) inherit unchanged

**Acceptance Criteria**:

- [ ] Object author access
- [ ] Install command per source type
- [ ] npm shows "coming soon"
- [ ] Component tests pass

### Task 4.3: [BATCH GATE] Verifying site fetch and UI batch

**Size**: Small
**Priority**: High
**Dependencies**: 4.2

**Commands**: `pnpm typecheck --filter @dorkos/site`, `pnpm lint --filter @dorkos/site`, `pnpm vitest run --filter @dorkos/site`, `pnpm build --filter @dorkos/site`.

**Acceptance Criteria**:

- [ ] Site typecheck/lint/test green
- [ ] `pnpm build --filter @dorkos/site` succeeds

---

## Batch 5: CLI Validators

### Task 5.1: Updating package validate-marketplace CLI for sidecar and CC schema

**Size**: Medium
**Priority**: High
**Dependencies**: 1.10
**Files**: `packages/cli/src/commands/package-validate-marketplace.ts`, tests

**Technical Requirements**:

- Read marketplace.json + sidecar (if `.claude-plugin/` path)
- Run DorkOS schema parse (passthrough) and CC strict second pass
- Enforce reserved names
- Emit structured 4-line summary
- Exit codes: 0 all pass, 1 DorkOS validation errors, 2 CC compatibility fails

**Acceptance Criteria**:

- [ ] All 5 checks run
- [ ] Exit codes distinguishable (0/1/2)
- [ ] 7 test scenarios pass (happy path, sidecar absent/invalid, DorkOS fails, CC fails, reserved, inline x-dorkos)

### Task 5.2: Updating package validate-remote CLI for sidecar fetch

**Size**: Small
**Priority**: Medium
**Dependencies**: 5.1
**Files**: `packages/cli/src/commands/package-validate-remote.ts`, tests

**Technical Requirements**:

- Fetch both marketplace.json and sidecar via HTTP in parallel
- Sidecar 404 non-fatal
- Same validation flow + exit codes as validate-marketplace

**Acceptance Criteria**:

- [ ] Parallel fetch
- [ ] 404 tolerated
- [ ] Exit codes match local command

### Task 5.3: Adding sync-cc-schema weekly cron script

**Size**: Medium
**Priority**: Medium
**Dependencies**: 1.10
**Parallel with**: 5.1, 5.2
**Files**: `scripts/sync-cc-schema.ts` (new), `.github/workflows/cc-schema-sync.yml` (new)

**Technical Requirements**:

- Fetches `hesreallyhim/claude-code-json-schema`, diffs against DorkOS Zod port
- Opens PR via `gh pr create` labeled `cc-schema-drift` when diff non-empty
- Exits 0 + logs "no drift" when identical
- Workflow runs Mondays 10:00 UTC, also manual dispatch
- Uses `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`

**Acceptance Criteria**:

- [ ] Script file exists and runs end-to-end
- [ ] Workflow file at `.github/workflows/cc-schema-sync.yml`
- [ ] Cron `0 10 * * 1`
- [ ] PR creation path tested with synthetic diff

### Task 5.4: [BATCH GATE] Verifying CLI validators batch

**Size**: Small
**Priority**: High
**Dependencies**: 5.1, 5.2, 5.3

**Commands**: CLI package typecheck/lint/test + smoke test of validate-marketplace against a minimal tmp fixture.

**Acceptance Criteria**:

- [ ] CLI package green
- [ ] Smoke test runs without runtime crash
- [ ] Exit codes behave as documented

---

## Batch 6: Telemetry and Seed Fixtures

### Task 6.1: Adding source_type column to marketplace_install_events Drizzle schema

**Size**: Medium
**Priority**: High
**Dependencies**: 2.9
**Files**: `apps/site/src/db/schema.ts`, new Drizzle migration, `apps/site/src/app/api/telemetry/install/route.ts`, `apps/server/src/services/marketplace/telemetry-reporter.ts`, tests

**Technical Requirements**:

- Text column with enum constraint (5 source types)
- 3-step migration: add nullable → backfill `'github'` → alter to NOT NULL
- Edge Function Zod schema updated
- Server-side telemetry reporter includes `sourceType` in payload
- Apply migration on dev Neon DB

**Acceptance Criteria**:

- [ ] Schema + migration + applied
- [ ] Edge Function updated
- [ ] Reporter updated
- [ ] Tests cover roundtrip

### Task 6.2: Rewriting seed fixture as same-repo monorepo with sidecar

**Size**: Large
**Priority**: High
**Dependencies**: 1.10
**Parallel with**: 6.1
**Files**: `packages/marketplace/fixtures/dorkos-seed/**`, `packages/marketplace/fixtures/legacy/` (moved)

**Technical Requirements**:

- New `fixtures/dorkos-seed/.claude-plugin/marketplace.json` (8 plugins, relative-path + pluginRoot, owner, metadata)
- New `fixtures/dorkos-seed/.claude-plugin/dorkos.json` (8 entries, featured/type/layers/icon/pricing)
- 8 plugin subdirectories with stub `plugin.json`, `README.md`, optional `skills/`
- Old fixture preserved via `git mv` into `fixtures/legacy/`
- marketplace.json must have ZERO DorkOS-specific fields inline

**Acceptance Criteria**:

- [ ] New fixture structure matches spec
- [ ] Legacy preserved via git mv
- [ ] AST test (in 6.3) will verify zero DorkOS keys inline

### Task 6.3: Adding cc-compat fixtures and Direction A bidirectional tests

**Size**: Medium
**Priority**: High
**Dependencies**: 6.2
**Files**: `packages/marketplace/fixtures/cc-compat/**`, `packages/marketplace/src/__tests__/cc-compat.test.ts`

**Technical Requirements**:

- 8 fixtures: minimal, full-cc-fields, sidecar-isolation (+ sidecar), relative-path, github, url, git-subdir, npm-stub
- Test file iterates every fixture: DorkOS parse passes, CC strict parse passes, `resolvePluginSource` succeeds, AST/key enumeration confirms no DorkOS keys in marketplace.json
- sidecar-isolation test proves merge produces 8 entries with dorkos extensions

**Acceptance Criteria**:

- [ ] 8 fixtures created
- [ ] Both DorkOS and CC schemas accept all
- [ ] AST/key check passes
- [ ] sidecar-isolation merge correct

### Task 6.4: Adding cc-real fixtures and Direction B parser tests

**Size**: Medium
**Priority**: High
**Dependencies**: 6.3
**Files**: `packages/marketplace/fixtures/cc-real/**`, `packages/marketplace/src/__tests__/cc-real.test.ts`

**Technical Requirements**:

- Vendor `anthropics/claude-plugins-official/.claude-plugin/marketplace.json` snapshot pinned to commit SHA
- `.sha` manifest with source URL, commit, capture date, refresh instructions
- Test asserts DorkOS parser consumes real CC marketplace
- Tests every plugin resolves via `resolvePluginSource`
- Source-type coverage assertions match snapshot
- Passthrough invariant test (unknown fields preserved)

**Acceptance Criteria**:

- [ ] Snapshot vendored with pinned SHA
- [ ] Every plugin parses and resolves
- [ ] Passthrough invariant test

### Task 6.5: Adding plugin runtime activation end-to-end test

**Size**: Medium
**Priority**: High
**Dependencies**: 3.4
**Parallel with**: 6.1, 6.2, 6.3, 6.4
**Files**: `apps/server/src/services/runtimes/claude-code/__tests__/integration/plugin-activation.test.ts` (new)

**Technical Requirements**:

- Install → enable → startSession → capture `query()` options
- 3 scenarios: single plugin install + activation, empty enabled list, enabled plugin with missing directory
- Mocks: `child_process.spawn`, `node:fs/promises`, SDK `query()`
- Asserts `options.plugins` array shape, warning logs

**Acceptance Criteria**:

- [ ] 3 scenarios pass
- [ ] No real network/filesystem
- [ ] Logger spy captures missing-dir warning

### Task 6.6: [BATCH GATE] Verifying telemetry and seed fixtures batch

**Size**: Small
**Priority**: High
**Dependencies**: 6.1, 6.2, 6.3, 6.4, 6.5

**Commands**: typecheck/lint/test for marketplace + server + site; verify Drizzle migration on Neon dev; verify seed fixture CLI validation clean; verify cc-real and cc-compat tests green.

**Acceptance Criteria**:

- [ ] All commands exit 0
- [ ] Seed validates clean
- [ ] Migration applied
- [ ] Bidirectional tests green

---

## Batch 7: Documentation and ADR Status

### Task 7.1: Rewriting contributing/marketplace-registry.md for new format

**Size**: Medium
**Priority**: High
**Dependencies**: 6.6
**Files**: `contributing/marketplace-registry.md`

**Technical Requirements**:

- 9 sections: repository layout, marketplace.json schema (5 source forms), sidecar, pluginRoot semantics, reserved names, strict superset framing, submission flow, validation, CC validator sync
- Link to ADRs 0236-0239
- No stale references to old format

**Acceptance Criteria**:

- [ ] All 9 sections
- [ ] ADR links
- [ ] No stale references

### Task 7.2: Updating contributing docs for installs, packages, telemetry, external-agent

**Size**: Medium
**Priority**: Medium
**Dependencies**: 7.1
**Files**: `contributing/marketplace-installs.md`, `contributing/marketplace-packages.md`, `contributing/marketplace-telemetry.md`, `contributing/external-agent-marketplace-access.md`, `docs/marketplace.mdx`

**Technical Requirements**:

- marketplace-installs: source-type dispatch table, sparse-clone sequence, fallback ladder, npm error surfacing
- marketplace-packages: sidecar strategy section
- marketplace-telemetry: `source_type` column section
- external-agent: acknowledge 5 source forms
- public docs: 5 source type examples + install command

**Acceptance Criteria**:

- [ ] All 5 files updated
- [ ] Source-type dispatch table present

### Task 7.3: Adding forward-pointer to marketplace-04 spec and finalizing ADR statuses

**Size**: Small
**Priority**: High
**Dependencies**: 7.1, 7.2
**Files**: `specs/marketplace-04-web-and-registry/04-implementation.md`, ADRs 0236-0239, `decisions/manifest.json`, `CLAUDE.md`, `CHANGELOG.md`

**Technical Requirements**:

- Forward-pointer banner at top of marketplace-04 implementation report
- Verify ADR front matter status, sections, manifest entry (do NOT recreate, they exist as drafts)
- CLAUDE.md marketplace section updated (new repo, new paths, new install command)
- CHANGELOG.md Unreleased → Changed entry

**Acceptance Criteria**:

- [ ] Forward-pointer visible
- [ ] ADRs verified
- [ ] CLAUDE.md + CHANGELOG.md updated

### Task 7.4: [BATCH GATE] Verifying documentation batch

**Size**: Small
**Priority**: High
**Dependencies**: 7.3

**Commands**: `pnpm format --check`, `/docs:coverage`, spot-read checks.

**Acceptance Criteria**:

- [ ] Format check green
- [ ] No stale references
- [ ] ADRs in manifest
- [ ] CLAUDE.md + CHANGELOG.md updated

---

## Batch 8: Manual Smoke Tests and Final Gate

### Task 8.1: Performing manual Claude Code validator smoke tests against rewritten seed

**Size**: Medium
**Priority**: High
**Dependencies**: 7.4
**Files**: `specs/marketplace-05-claude-code-format-superset/04-implementation.md` (populated), `github.com/dork-labs/marketplace` (new repo)

**Technical Requirements**:

- Test 1: `claude plugin validate` against seed → PASS
- Test 2: inline-x-dorkos tmp fixture → FAIL with additionalProperties error
- Test 3: Bootstrap `github.com/dork-labs/marketplace` with the seed content (execution of formerly-#28 with the new schema)

**Acceptance Criteria**:

- [ ] Both validator results recorded
- [ ] dork-labs/marketplace repo live with correct structure

### Task 8.2: Performing end-to-end manual install tests via CC and DorkOS

**Size**: Medium
**Priority**: High
**Dependencies**: 8.1

**Technical Requirements**:

- Test 4: `claude plugin marketplace add dork-labs/marketplace`
- Test 5: `claude plugin install code-reviewer@dorkos`
- Test 6: DorkOS UI install + enable + session → verify plugin namespaced skills appear (`code-reviewer:<skill>`)
- Test 7: Document all 7 test results in `04-implementation.md`

**Acceptance Criteria**:

- [ ] Tests 4-6 PASS
- [ ] Implementation report populated with full results
- [ ] Forward-pointer in marketplace-04 confirmed live

### Task 8.3: [FINAL BATCH GATE] Running full repo verification and unblocking #28

**Size**: Small
**Priority**: High
**Dependencies**: 8.2

**Commands**: `pnpm format --check`, `pnpm lint`, `pnpm typecheck`, `pnpm test -- --run`, `pnpm build`.

Additional checks: manual smoke tests documented, ADRs 0236-0239 accepted, dork-labs/marketplace live, spec manifest status updated, CHANGELOG Unreleased entry, final CLI validate-marketplace smoke test.

**Acceptance Criteria**:

- [ ] All 5 quality gate commands exit 0
- [ ] Manual smoke tests documented
- [ ] ADRs accepted
- [ ] dork-labs/marketplace live with seed content
- [ ] Spec manifest status updated
- [ ] #28 declared unblocked
- [ ] CHANGELOG Unreleased entry present

---

## Critical Path

1.1 → 1.2 → 1.7 → 1.8 → 1.9 → 1.10 → 2.6 → 2.7 → 2.8 → 2.9 → 3.3 → 3.4 → 6.5 → 6.6 → 7.1 → 7.2 → 7.3 → 7.4 → 8.1 → 8.2 → 8.3

## Parallel Opportunities

- **Batch 1**: 1.3, 1.4, 1.5, 1.6 are all parallel-safe after 1.2 lands (same upstream dependency, separate files).
- **Batch 2**: 2.1, 2.2, 2.3, 2.4, 2.5 are all parallel-safe (independent resolver files); 2.6 joins them.
- **Batch 3**: 3.1 and 3.2 are parallel-safe.
- **Batch 5**: 5.1, 5.2, 5.3 can overlap (5.2 depends on 5.1 for shared helpers but 5.3 is independent).
- **Batch 6**: 6.1 (telemetry) and 6.2 (seed) and 6.5 (runtime e2e) can all run in parallel. 6.3 and 6.4 are sequential after 6.2.
- **Phases 2, 3, 4, 5 can start as soon as Batch 1 gate passes** — the server pipeline (P2), runtime activation (P3), site UI (P4), and CLI validators (P5) are all downstream of the schema layer but independent of each other.
