# Implementation Summary: Marketplace 01: Foundation

**Created:** 2026-04-06
**Last Updated:** 2026-04-06
**Spec:** specs/marketplace-01-foundation/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 25 / 25

## Tasks Completed

### Session 1 - 2026-04-06

**Batch 1:**

- Task #1: [P1] Scaffold @dorkos/marketplace package
- Task #8: [P2] Add optional `kind` field to SkillFrontmatterSchema

**Batch 2:**

- Task #2: [P1] Implement constants.ts and slug.ts
- Task #3: [P1] Implement package-types.ts (PackageType enum + helpers)
- Task #9: [P2] Append addendum to ADR-0220 documenting optional `kind` field
- Task #22: [P5] Add packages/marketplace to AGENTS.md package list

**Batch 3:**

- Task #4: [P1] Implement manifest-schema.ts (discriminated union over 4 package types)
- Task #5: [P1] Implement marketplace-json-schema.ts and marketplace-json-parser.ts
- Task #10: [P3] Implement package-scanner.ts (Node.js only)
- Task #12: [P3] Implement scaffolder.ts (createPackage function)

**Batch 4:**

- Task #6: [P1] Write index.ts barrel (browser-safe exports only)
- Task #11: [P3] Implement package-validator.ts (Node.js only) — adapted to actual `@dorkos/skills/scanner` API
- Task #13: [P3] Create test fixtures for validator (7 fixture directories)

**Batch 5:**

- Task #7: [P1] Unit tests for manifest-schema, marketplace-json-schema, marketplace-json-parser (74 tests)
- Task #14: [P3] Unit tests for package-validator, package-scanner, scaffolder (31 tests, 1 skipped). Required a follow-up agent — the original agent stopped after writing 2 of 3 files.

**Marketplace package test suite: 104 passing, 1 skipped (6 files)**

**Batch 6:**

- Task #15: [P3] Build and lint the @dorkos/marketplace package — all gates passed, dist/ produced with 11 subpath entries

**Batch 7:**

- Task #16: [P4] Add @dorkos/marketplace dependency to packages/cli
- Task #21: [P5] Write packages/marketplace/README.md (74 lines, all 6 sections)
- Task #23: [P5] Add CHANGELOG entry under Unreleased
- Task #24: [P5] Create contributing/marketplace-packages.md stub

**Batch 8:**

- Task #17: [P4] Implement `dorkos package init` command (via `packages/cli/src/package-init-command.ts` with dedicated `parsePackageInitArgs`)
- Task #18: [P4] Implement `dorkos package validate` command (via `packages/cli/src/package-validate-command.ts`)
- Main context wired both into `packages/cli/src/cli.ts` as a pre-parseArgs `package` subcommand interceptor, added help text, and fixed a CLI bundler bug (added `gray-matter` to esbuild externals so the validator resolves `require('fs')` at runtime).

**Batch 9:**

- Task #19: [P4] CLI tests for package init and package validate (26 new tests — 15 init + 11 validate, CLI test suite now at 120 total)

**Batch 10:**

- Task #20: [P4] E2E smoke test — all 7 steps passed: plugin init+validate, agent init+validate (no `.claude-plugin`), skill-pack init+validate, adapter init + validate (adapter validate correctly fails on the documented `adapterType` scaffolder gap), overwrite refusal.

**Batch 11:**

- Task #25: [P5] Final acceptance verification — all gates passed. Marketplace: typecheck ✓, lint ✓, build ✓, 104 tests + 1 skipped ✓. Skills: 113 tests ✓ (104 existing + 9 new `kind` field). CLI: 120 tests ✓ (94 existing + 26 new). All documentation artifacts present. Zero destructive changes to existing apps/server, apps/client, apps/obsidian-plugin, packages/mesh, packages/relay, packages/db. No new external runtime dependencies (gray-matter was pre-existing). No TODOs/FIXMEs/XXX markers in marketplace source.

## Files Modified/Created

**Source files:**

- `packages/marketplace/package.json` (created)
- `packages/marketplace/tsconfig.json` (created)
- `packages/marketplace/eslint.config.js` (created)
- `packages/marketplace/vitest.config.ts` (created)
- `packages/marketplace/README.md` (created — stub)
- `packages/marketplace/src/index.ts` (created — placeholder, overwritten in task #6)
- `packages/marketplace/src/constants.ts` (created)
- `packages/marketplace/src/slug.ts` (created — re-exports from `@dorkos/skills/slug`)
- `packages/marketplace/src/package-types.ts` (created)
- `packages/marketplace/src/manifest-schema.ts` (created — Zod discriminated union over 4 package types)
- `packages/marketplace/src/manifest-types.ts` (created — thin type re-exports)
- `packages/marketplace/src/marketplace-json-schema.ts` (created — CC-compatible with DorkOS extensions)
- `packages/marketplace/src/marketplace-json-parser.ts` (created — tolerant parser with discriminated result)
- `packages/marketplace/src/package-scanner.ts` (created — Node.js only, non-recursive)
- `packages/marketplace/src/scaffolder.ts` (created — Node.js only, refuses overwrites)
- `packages/marketplace/src/index.ts` (overwritten — real browser-safe barrel, placeholder from task #1 replaced)
- `packages/marketplace/src/package-validator.ts` (created — Node.js only, six error codes)
- `packages/marketplace/src/__tests__/fixtures/` (created — 7 fixture directories: valid-plugin, valid-agent, valid-skill-pack, valid-adapter, invalid-no-manifest, invalid-manifest-shape, claude-code-plugin)
- `packages/marketplace/src/__tests__/manifest-schema.test.ts` (created — 42 tests)
- `packages/marketplace/src/__tests__/marketplace-json-schema.test.ts` (created — 22 tests)
- `packages/marketplace/src/__tests__/marketplace-json-parser.test.ts` (created — 10 tests)
- `packages/marketplace/src/__tests__/package-validator.test.ts` (created — 12 tests)
- `packages/marketplace/src/__tests__/package-scanner.test.ts` (created — 4 tests)
- `packages/marketplace/src/__tests__/scaffolder.test.ts` (created — 15 tests, 1 skipped)
- `packages/skills/src/schema.ts` (modified — added `SkillKindSchema`, `SkillKind`, optional `kind` field)
- `packages/skills/src/index.ts` (modified — re-exports `SkillKindSchema`/`SkillKind`)
- `decisions/0220-adopt-skill-md-open-standard.md` (modified — appended addendum for optional `kind` field)
- `AGENTS.md` (modified — added `packages/marketplace/` entry to monorepo structure)

**Test files:**

- `packages/skills/src/__tests__/schema.test.ts` (modified — +9 tests for kind field)

## Known Issues

- **Task #11 (package-validator.ts)**: `@dorkos/skills/scanner` signature differs from the spec (`scanSkillDirectory(dir, schema, options?)` returning `ParseResult<ParsedSkill<T>>[]`, not `scanSkillDirectory(dir)` returning `{ dirPath, filePath }[]`). Validator adapted by passing `z.unknown()` as a permissive frontmatter schema. Verified working against fixtures via task #14 tests. No functional impact — error codes preserved.

- **CLI bundler bug fix (Task #18)**: The CLI's esbuild bundle did not externalize `gray-matter`, which is a transitive dependency of the validator via `@dorkos/skills/parser`. Gray-matter uses CommonJS `require('fs')` which esbuild's ESM output cannot inline via dynamic requires, causing `dorkos package validate` to throw `Dynamic require of "fs" is not supported` at runtime. Fixed in `packages/cli/scripts/build.ts` by adding `'gray-matter'` to the CLI bundle's externals list. The server bundle already externalized it. Smoke tested: `package init` then `package validate` end-to-end roundtrip now works.

## Post-Review Fixes (Session 2 — 2026-04-06)

After completing Session 1, an independent code review by the `code-reviewer` subagent surfaced 3 important issues and 4 notable minor issues. All have been resolved:

- **Adapter scaffolder gap (was Important #2)** — `CreatePackageOptions` now accepts an optional `adapterType` field. When `type === 'adapter'`, the scaffolder writes `adapterType: opts.adapterType ?? opts.name` so the manifest is always schema-valid. The CLI accepts a new `--adapter-type` flag. The previously-skipped adapter round-trip test in `scaffolder.test.ts` is unskipped, and two new adapter tests cover explicit `adapterType` and the per-type ignore (non-adapter packages don't write the field).
- **`parsePackageInitArgs` direct `process.exit` (was Important #3)** — Refactored to throw plain `Error` objects instead of calling `process.exit(1)`. The CLI dispatcher in `cli.ts` is now the single source of truth for exit-code policy. `package-init.test.ts` tests updated to assert on `.toThrow(/regex/)` instead of mocking `process.exit`.
- **Overwrite error UX (was Important #1)** — Both `package init` and `package validate` are now wrapped in a try/catch in `cli.ts` that prints `Error: <message>` (one clean line) and exits 1. No more raw Node.js stack traces on overwrite collisions, missing arguments, or schema violations.
- **`SKILL_SOURCE_DIRS` missing `commands/` (was Minor #1)** — Added `'commands'` to the validator's source-dir list so SKILL.md files dropped into the plugin scaffolder's auto-created `commands/` directory are validated.
- **Misleading TSDoc on `type` field (was Minor #2)** — Reworded the comment in `marketplace-json-schema.ts` to make explicit that the schema does NOT apply a Zod default; consumers should treat absence as `plugin`.
- **`--help` for `package` subcommand (was Minor #4)** — `dorkos package`, `dorkos package --help`, and `dorkos package -h` now print package-specific usage.
- **Warnings-only success path missing CLI test (was Minor #3)** — Added `package-validate.test.ts > warnings-only success path` test that creates a package with mismatched directory name, asserts `NAME_DIRECTORY_MISMATCH` warning, `⚠` prefix, and `Package is valid (with warnings)` status with exit 0.

**Post-fix test counts:** marketplace 107 · skills 113 · CLI 124. End-to-end smoke test verified all four package types init+validate cleanly through the bundled CLI, and all error paths print clean one-line messages.

## Implementation Notes

### Session 1

Implemented the marketplace foundation spec in 11 dependency-aware parallel batches. Spawned ~19 background implementation agents, one follow-up completion agent (task #14 scaffolder tests needed a re-dispatch after the original agent stopped early), and 1 analysis agent.

Two minor known gaps were initially flagged for follow-up but were closed in Session 2 (see "Post-Review Fixes" above).

One build-system bug was found and fixed during the CLI smoke test: `gray-matter` was not in the CLI bundle's esbuild externals list, causing `dorkos package validate` to throw `Dynamic require of "fs" is not supported` at runtime. Fix landed in `packages/cli/scripts/build.ts`.

### Session 2

Independent code review caught 3 important + 4 notable minor issues. All resolved inline by the main context (no agents needed — small targeted edits). Closed the adapter scaffolder gap, refactored `parsePackageInitArgs` to throw instead of exit, wrapped the CLI dispatcher in a try/catch for clean error messages, added `commands/` to validator source dirs, fixed misleading TSDoc, added package-level `--help`, and added a missing CLI test for the warnings-only success path.

**Final test counts (post Session 2):** marketplace 107 · skills 113 · CLI 124 = **344 total**.
**Final artifact counts:** 15 new source files, 6 new test files, 7 fixture directories, 3 new documentation files, 7 modified files (schema.ts in skills, AGENTS.md, CHANGELOG.md, ADR-0220, cli.ts, build.ts in cli, scaffolder.ts + package-validator.ts + marketplace-json-schema.ts in marketplace, package-init-command.ts).
