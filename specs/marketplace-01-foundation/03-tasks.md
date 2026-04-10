# Task Breakdown: Marketplace Foundation

Generated: 2026-04-06
Source: specs/marketplace-01-foundation/02-specification.md
Last Decompose: 2026-04-06

## Overview

This spec delivers the foundational `@dorkos/marketplace` package — schemas, parser, validator, scanner, and scaffolder for DorkOS marketplace packages — plus two new CLI subcommands (`dorkos package init` and `dorkos package validate`) and a small ADR-0220 addendum adding an optional `kind` field to `SkillFrontmatterSchema`. This is spec 1 of 5 in the DorkOS Marketplace project and produces no install logic, UI, registry, or MCP server (those land in specs 02–05).

The tasks below are ordered into 5 phases. Phase 1 (package scaffolding + schemas + parser) and Phase 2 (`kind` field addendum) are fully parallel. Phase 3 (validator/scanner/scaffolder) depends on Phase 1's schema being in place. Phase 4 (CLI) depends on the full marketplace package building cleanly. Phase 5 (docs + polish) closes out the spec.

## Phase 1: Foundation — Package Scaffolding & Schemas

### Task 1.1: Scaffold @dorkos/marketplace package (package.json, tsconfig, eslint, vitest)

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 2.1 (kind field addendum)

Create `packages/marketplace/` with `package.json` (matching the spec verbatim — all 11 subpath exports, `zod` + `@dorkos/skills` deps), `tsconfig.json` extending `@dorkos/typescript-config/node.json`, `eslint.config.js` mirroring `packages/skills`, `vitest.config.ts`, empty `src/` + `src/__tests__/` directories, and a README stub. Run `pnpm install` from the root after creation.

**Acceptance**: `pnpm install`, `pnpm --filter=@dorkos/marketplace typecheck` and `lint` all succeed.

### Task 1.2: Implement constants.ts and slug.ts

**Size**: Small
**Priority**: High
**Dependencies**: 1.1
**Can run parallel with**: 1.3

Create `constants.ts` exporting `PACKAGE_MANIFEST_FILENAME`, `PACKAGE_MANIFEST_PATH`, `CLAUDE_PLUGIN_MANIFEST_PATH`, `MARKETPLACE_JSON_FILENAME`, `PACKAGE_MANIFEST_VERSION`. Create `slug.ts` re-exporting from `@dorkos/skills/slug`.

### Task 1.3: Implement package-types.ts (PackageType enum + helpers)

**Size**: Small
**Priority**: High
**Dependencies**: 1.1
**Can run parallel with**: 1.2

Create `PackageTypeSchema = z.enum(['agent', 'plugin', 'skill-pack', 'adapter'])`, the `PackageType` type, and the `requiresClaudePlugin(type)` helper (returns `false` only for `'agent'`). Per ADR-0230, the agent type is named `agent` not `agent-template`.

### Task 1.4: Implement manifest-schema.ts (MarketplacePackageManifestSchema Zod discriminated union)

**Size**: Large
**Priority**: High
**Dependencies**: 1.2, 1.3
**Can run parallel with**: 1.5

Build the full `.dork/manifest.json` schema as a Zod discriminated union over `type` with variants `PluginManifestSchema`, `AgentManifestSchema`, `SkillPackManifestSchema`, `AdapterManifestSchema`. Private helpers: `SemverSchema`, `DependencyDeclarationSchema`, `PackageLayerSchema`. Export all five types (`MarketplacePackageManifest`, `PluginPackageManifest`, `AgentPackageManifest`, `SkillPackPackageManifest`, `AdapterPackageManifest`). Also create `manifest-types.ts` as a type-only re-export.

### Task 1.5: Implement marketplace-json-schema.ts and marketplace-json-parser.ts

**Size**: Medium
**Priority**: High
**Dependencies**: 1.3
**Can run parallel with**: 1.4

Create the Claude Code-compatible `marketplace.json` schema. Merge `ClaudeCodeStandardEntrySchema` + `DorkosExtensionFieldsSchema` with `.passthrough()`. Top-level `{ name, plugins }` also uses `.passthrough()`. The parser returns a discriminated `{ ok: true, marketplace } | { ok: false, error }` result with distinct error messages for JSON parse failures and schema failures.

### Task 1.6: Write index.ts barrel (browser-safe exports only)

**Size**: Small
**Priority**: High
**Dependencies**: 1.2, 1.3, 1.4, 1.5
**Can run parallel with**: (none)

Create `index.ts` exporting only browser-safe modules: schemas, parser, types, constants. Node.js-only modules (`package-validator`, `package-scanner`, `scaffolder`) are explicitly excluded.

### Task 1.7: Unit tests for manifest-schema, marketplace-json-schema, and marketplace-json-parser

**Size**: Large
**Priority**: High
**Dependencies**: 1.4, 1.5, 1.6
**Can run parallel with**: (none)

Vitest unit tests covering: valid manifests for all four variants, discriminated union narrowing, invalid manifest rejection (missing name, bad semver, bad type, adapter without `adapterType`, overlong description, tags > 20), parameterized dependency-declaration format tests, default-value application, standard CC marketplace.json, DorkOS-extended marketplace.json, passthrough preservation, parser malformed-JSON and schema-violation branches.

## Phase 2: `kind` Field Addendum

### Task 2.1: Add optional `kind` field to SkillFrontmatterSchema in @dorkos/skills

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: All of Phase 1

Add `SkillKindSchema = z.enum(['skill', 'task', 'command'])` and optional `kind` field to `SkillFrontmatterSchema` in `packages/skills/src/schema.ts`. Update `packages/skills/src/__tests__/schema.test.ts` with tests covering: existing frontmatter unchanged, each valid kind value, one invalid value, direct `SkillKindSchema.parse` round-trip. All existing tests must continue to pass.

### Task 2.2: Append addendum to ADR-0220 documenting optional `kind` field

**Size**: Small
**Priority**: Medium
**Dependencies**: 2.1

Append a `## Addendum (2026-04-06): Optional kind Field` section to `decisions/0220-adopt-skill-md-open-standard.md` with the full rationale, inference rules (1. cron → task; 2. commands/ → command; 3. otherwise → skill), and guidance that marketplace authors SHOULD specify kind explicitly. Do NOT create a new ADR (ADR-0229 is the extracted draft but canonical docs live on 0220).

## Phase 3: Validator, Scanner, Scaffolder

### Task 3.1: Implement package-scanner.ts (Node.js only)

**Size**: Small
**Priority**: High
**Dependencies**: 1.2
**Can run parallel with**: 3.2, 3.3

Implement `scanPackageDirectory(rootPath)` returning `ScannedPackage[]`. Scans only immediate children (no recursion). Identifies packages by presence of `.dork/manifest.json`. Silently skips non-directory entries and directories without the manifest file.

### Task 3.2: Implement package-validator.ts (Node.js only)

**Size**: Large
**Priority**: High
**Dependencies**: 1.2, 1.4
**Can run parallel with**: 3.1, 3.3

Implement `validatePackage(packagePath)` returning `{ ok, issues, manifest? }`. Error codes: `MANIFEST_MISSING`, `MANIFEST_INVALID_JSON`, `MANIFEST_SCHEMA_INVALID`, `CLAUDE_PLUGIN_MISSING`, `SKILL_INVALID`, `NAME_DIRECTORY_MISMATCH` (warning only). Walks five conventional SKILL.md directories and validates each bundled skill via `@dorkos/skills/scanner` + `@dorkos/skills/validator`. Returns early after `MANIFEST_MISSING` / `MANIFEST_INVALID_JSON` / `MANIFEST_SCHEMA_INVALID`.

### Task 3.3: Implement scaffolder.ts (createPackage function)

**Size**: Medium
**Priority**: High
**Dependencies**: 1.2, 1.3
**Can run parallel with**: 3.1, 3.2

Implement `createPackage(opts)` writing `.dork/manifest.json`, conditional `.claude-plugin/plugin.json`, `README.md`, and type-specific starter directories. Refuses to overwrite existing directories (throws on any non-ENOENT error from `fs.access`). Private helpers `defaultLayersForType` and `starterDirsForType` handle all four package types via exhaustive switch.

### Task 3.4: Create test fixtures for validator (valid and invalid packages)

**Size**: Medium
**Priority**: High
**Dependencies**: 1.4
**Can run parallel with**: 3.1, 3.2, 3.3

Create seven fixture directories under `packages/marketplace/src/__tests__/fixtures/`: `valid-plugin/`, `valid-agent/`, `valid-skill-pack/`, `valid-adapter/`, `invalid-no-manifest/`, `invalid-manifest-shape/`, `claude-code-plugin/`. Each valid fixture has a complete manifest that passes schema validation plus the required `.claude-plugin/plugin.json` where applicable. The `valid-plugin` fixture also includes a `skills/example-skill/SKILL.md` with valid frontmatter for exercising the bundled SKILL.md validation path.

### Task 3.5: Unit tests for package-validator, package-scanner, and scaffolder

**Size**: Large
**Priority**: High
**Dependencies**: 3.1, 3.2, 3.3, 3.4
**Can run parallel with**: (none)

Vitest tests covering every error code in the validator, scanner edge cases (empty, mixed, no-recursion), and scaffolder behavior for all four types including the round-trip `createPackage` → `validatePackage` proof and refusal-to-overwrite. Use `os.tmpdir() + crypto.randomUUID()` for ephemeral dirs and clean up in `afterEach`.

### Task 3.6: Build and lint the @dorkos/marketplace package

**Size**: Small
**Priority**: High
**Dependencies**: 1.7, 3.5

Run `typecheck`, `lint`, `build`, and `test --run` against `@dorkos/marketplace` as a pre-integration checkpoint. No TSDoc lint warnings, no unused imports, no uncovered branches. `dist/` should be gitignored.

## Phase 4: CLI Subcommands

### Task 4.1: Add @dorkos/marketplace dependency to packages/cli

**Size**: Small
**Priority**: High
**Dependencies**: 3.6

Add `@dorkos/marketplace: workspace:*` to `packages/cli/package.json`. Verify the workspace link and confirm there is no reverse dependency (marketplace → skills only, never the other way).

### Task 4.2: Implement `dorkos package init` command

**Size**: Medium
**Priority**: High
**Dependencies**: 4.1
**Can run parallel with**: 4.3

Create `packages/cli/src/commands/package-init.ts` with the `runPackageInit(args)` wrapper over `createPackage`. Defaults type to `plugin`. Supports `--type`, `--parent-dir`, `--description`, `--author` flags. Register in the existing CLI entry point following project conventions.

### Task 4.3: Implement `dorkos package validate` command

**Size**: Medium
**Priority**: High
**Dependencies**: 4.1
**Can run parallel with**: 4.2

Create `packages/cli/src/commands/package-validate.ts` with `runPackageValidate(args)` returning a numeric exit code (0 for valid, 0 for warnings-only, 1 for errors). Does NOT call `process.exit` directly — the caller handles exit-code propagation. Output uses `✓` and `✗` prefixes plus `⚠` for warnings.

### Task 4.4: CLI tests for package init and package validate

**Size**: Medium
**Priority**: High
**Dependencies**: 4.2, 4.3, 3.4

Vitest tests for both CLI commands. `package-init.test.ts` scaffolds each type into a temp dir and validates the result. `package-validate.test.ts` runs against the checked-in fixtures, asserts exit codes and output format, and verifies the `process.cwd()` default branch.

### Task 4.5: Smoke test CLI end-to-end

**Size**: Small
**Priority**: Medium
**Dependencies**: 4.2, 4.3, 4.4

Run a scripted smoke workflow from `/tmp`: scaffold each of the four package types, validate each, and verify the overwrite-refusal path. Uses the built CLI bundle, not Vitest.

## Phase 5: Documentation & Polish

### Task 5.1: Write packages/marketplace/README.md

**Size**: Small
**Priority**: Medium
**Dependencies**: 3.6
**Can run parallel with**: 5.2, 5.3, 5.4

Replace the stub README with a developer-facing overview: purpose, exports table, three usage examples (schema validation, parser, validator), CLI commands, related ADR links, out-of-scope line. Under 100 lines.

### Task 5.2: Add packages/marketplace to AGENTS.md package list

**Size**: Small
**Priority**: Medium
**Dependencies**: 1.1
**Can run parallel with**: 5.1, 5.3, 5.4

Add a single line to the monorepo structure diagram in root `AGENTS.md` listing `packages/marketplace/` alongside the other packages. Preserve surrounding indentation and tree-drawing characters.

### Task 5.3: Add CHANGELOG entry under Unreleased

**Size**: Small
**Priority**: Medium
**Dependencies**: 3.6
**Can run parallel with**: 5.1, 5.2, 5.4

Add a Keep-a-Changelog-style `### Added` block under `## Unreleased` in `CHANGELOG.md` listing the new package, two CLI commands, and the optional `kind` field.

### Task 5.4: Create contributing/marketplace-packages.md stub

**Size**: Small
**Priority**: Low
**Dependencies**: 3.6
**Can run parallel with**: 5.1, 5.2, 5.3

Create a stub developer guide at `contributing/marketplace-packages.md` introducing marketplace packages, the four types, the scaffold/validate workflow, manifest schema summary, and links to the relevant ADRs. Flag that install workflows are deferred to spec 02.

### Task 5.5: Final acceptance verification

**Size**: Small
**Priority**: High
**Dependencies**: 4.5, 5.1, 5.2, 5.3, 5.4, 2.2

Run the full acceptance-criteria checklist from the spec verbatim: workspace typecheck/lint, marketplace build, CLI scaffold + validate against plugin and agent, `@dorkos/skills` tests unchanged, ADR-0220 addendum present, docs present, no lingering TODOs. This is the go/no-go gate for marking the spec as implemented.

## Parallelization Map

**Parallel batches** (tasks in each list can all run simultaneously):

- **Batch A (entry)**: 1.1, 2.1
- **Batch B (after 1.1)**: 1.2, 1.3, 2.1
- **Batch C (after 1.2 + 1.3)**: 1.4, 1.5
- **Batch D (after 1.4 + 1.5)**: 1.6
- **Batch E (after 1.6)**: 1.7 (alongside 2.2 which needs 2.1)
- **Batch F (after 1.4)**: 3.1, 3.2, 3.3, 3.4 all parallel
- **Batch G (after Batch F + 1.7)**: 3.5
- **Batch H (after 3.5)**: 3.6
- **Batch I (after 3.6)**: 4.1
- **Batch J (after 4.1)**: 4.2, 4.3 parallel
- **Batch K (after 4.2 + 4.3 + 3.4)**: 4.4
- **Batch L (after 4.4)**: 4.5
- **Batch M (after 3.6)**: 5.1, 5.3, 5.4 parallel (5.2 can run as early as Batch A)
- **Batch N (final)**: 5.5

## Critical Path

1.1 → 1.2/1.3 → 1.4 → 1.7 → 3.2 → 3.5 → 3.6 → 4.1 → 4.2/4.3 → 4.4 → 4.5 → 5.5
