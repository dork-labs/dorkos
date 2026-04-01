# Task Breakdown: Skills Package

Generated: 2026-03-31
Source: specs/skills-package/02-specification.md

## Overview

This breakdown covers the implementation of `packages/skills/` (`@dorkos/skills`), a shared package implementing the agentskills.io SKILL.md open standard as the foundation for DorkOS task definitions, slash command definitions, and skill definitions.

The work is split into two phases:

- **Phase 1 (Foundation)** — Package scaffolding, Zod schemas, type definitions, constants, and browser-safe utilities. No filesystem I/O.
- **Phase 2 (File I/O)** — Node.js-only modules for parsing, writing, scanning, and validating SKILL.md files on disk.

---

## Phase 1: Foundation (Schemas and Utilities)

### Task 1.1: Scaffold packages/skills/ with package.json, tsconfig.json, and turbo wiring

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None

Create the `packages/skills/` directory with:

- `package.json` — named `@dorkos/skills`, private, ESM (`"type": "module"`), with all 11 subpath exports (`./schema`, `./task-schema`, `./command-schema`, `./types`, `./constants`, `./slug`, `./duration`, `./parser`, `./writer`, `./scanner`, `./validator`). Dependencies: `gray-matter ^4.0.3`, `zod ^3.24.0`. Dev dependencies: `@dorkos/eslint-config`, `@dorkos/typescript-config`, `vitest`.
- `tsconfig.json` — extends `@dorkos/typescript-config/node.json`, outputs to `./dist`, includes `src/**/*`, excludes `src/__tests__/**`.
- Wire into Turborepo and run `pnpm install`.

**Gate**: Package is recognized by the monorepo (`pnpm --filter @dorkos/skills` resolves).

---

### Task 1.2: Implement base SkillFrontmatterSchema and tests

**Size**: Medium
**Priority**: High
**Dependencies**: 1.1
**Can run parallel with**: 1.3, 1.4, 1.5

Implement `packages/skills/src/schema.ts` with:

- `SkillNameSchema` — 1-64 chars, lowercase alphanumeric + hyphens, no leading/trailing/consecutive hyphens.
- `SkillFrontmatterSchema` — requires `name` (via `SkillNameSchema`) and `description` (1-1024 chars), optional `license`, `compatibility` (max 500), `metadata` (Record<string, string>), `allowed-tools`.
- `SkillFrontmatter` type export.

Tests in `schema.test.ts`: 11+ test cases covering valid minimal/full frontmatter, rejection of missing fields, invalid names (uppercase, consecutive hyphens, leading/trailing hyphen, too long), description length validation, metadata type checking.

---

### Task 1.3: Implement constants, types, and slug utilities with tests

**Size**: Medium
**Priority**: High
**Dependencies**: 1.1
**Can run parallel with**: 1.2, 1.4, 1.5

Three modules:

- **`constants.ts`** — `SKILL_FILENAME = 'SKILL.md'`, `SKILL_SUBDIRS = ['scripts', 'references', 'assets']`, `skillFilePath()`, `skillDirPath()` path helpers.
- **`types.ts`** — `ParseResult<T>` discriminated union, `SkillDefinition`, `TaskDefinition`, `CommandDefinition` interfaces.
- **`slug.ts`** — `validateSlug()`, `slugify()`, `humanize()` functions.

Tests in `slug.test.ts`: 15+ test cases covering validation rules, slugification edge cases, humanization, round-trip behavior.

---

### Task 1.4: Implement duration utilities with DurationSchema and tests

**Size**: Small
**Priority**: High
**Dependencies**: 1.1
**Can run parallel with**: 1.2, 1.3, 1.5

Implement `packages/skills/src/duration.ts` with:

- `DurationSchema` — Zod schema for strings like `"5m"`, `"1h"`, `"30s"`, `"2h30m"`, `"1h15m30s"`.
- `parseDuration(duration: string): number` — converts to milliseconds.
- `formatDuration(ms: number): string` — converts from milliseconds.

Tests in `duration.test.ts`: 15+ test cases covering schema validation, parsing each unit, combined durations, formatting, zero handling, round-trip behavior.

---

### Task 1.5: Implement TaskFrontmatterSchema and CommandFrontmatterSchema with tests

**Size**: Medium
**Priority**: High
**Dependencies**: 1.1, 1.2, 1.4
**Can run parallel with**: 1.3

Two extension schemas:

- **`task-schema.ts`** — extends `SkillFrontmatterSchema` with `display-name`, `cron`, `timezone` (default UTC), `enabled` (default true), `max-runtime` (DurationSchema), `permissions` (default acceptEdits). Intentionally excludes `agentId`, `cwd`, `tags`.
- **`command-schema.ts`** — extends `SkillFrontmatterSchema` with `argument-hint`, `disable-model-invocation`, `user-invocable` (default true), `context`, `agent`, `model`, `effort`.

Tests in `task-schema.test.ts` (8 cases) and `command-schema.test.ts` (8 cases): default application, field acceptance, invalid value rejection, base schema enforcement.

---

### Task 1.6: Implement barrel index.ts and verify full Phase 1 build

**Size**: Small
**Priority**: High
**Dependencies**: 1.2, 1.3, 1.4, 1.5
**Can run parallel with**: None

Create `packages/skills/src/index.ts` that re-exports all browser-safe modules (schemas, types, constants, slug, duration). Does NOT re-export Node.js-only modules (parser, writer, scanner, validator).

Run Phase 1 gate:

```bash
pnpm --filter @dorkos/skills typecheck
pnpm --filter @dorkos/skills build
pnpm --filter @dorkos/skills test -- --run
pnpm typecheck  # repo-wide
```

---

## Phase 2: File I/O

### Task 2.1: Implement parseSkillFile parser with tests

**Size**: Medium
**Priority**: High
**Dependencies**: 1.6
**Can run parallel with**: 2.2, 2.4

Implement `packages/skills/src/parser.ts` — generic `parseSkillFile<T>(filePath, content, schema)` that:

1. Validates filename is `SKILL.md`.
2. Parses frontmatter with gray-matter.
3. Validates against provided Zod schema.
4. Validates `name` field matches parent directory name.
5. Returns discriminated `ParseResult<ParsedSkill<T>>`.

Tests in `parser.test.ts`: 7 test cases covering valid parsing with base and task schemas, wrong filename, invalid frontmatter, name/directory mismatch, empty body, malformed YAML.

---

### Task 2.2: Implement writeSkillFile and deleteSkillDir with tests

**Size**: Medium
**Priority**: High
**Dependencies**: 1.6
**Can run parallel with**: 2.1, 2.4

Implement `packages/skills/src/writer.ts`:

- `writeSkillFile(parentDir, name, frontmatter, body)` — creates `{parentDir}/{name}/SKILL.md` atomically using temp file + rename.
- `deleteSkillDir(parentDir, name)` — removes skill directory recursively.

Tests in `writer.test.ts`: 6 test cases using `fs.mkdtemp()` temp directories — directory creation, content correctness, overwrite, no temp file residue, deletion, safe deletion of non-existent.

---

### Task 2.3: Implement scanSkillDirectory with tests

**Size**: Medium
**Priority**: High
**Dependencies**: 2.1
**Can run parallel with**: 2.4

Implement `packages/skills/src/scanner.ts` — generic `scanSkillDirectory<T>(dir, schema)` that scans a parent directory for skill subdirectories containing SKILL.md files. Skips dotfiles, non-directories, and directories without SKILL.md. Returns empty array for non-existent directories.

Note: Corrects the `filePath`/`skillPath` bug from the spec.

Tests in `scanner.test.ts`: 6 test cases using temp directories — multiple valid skills, dotfile skip, missing SKILL.md skip, non-existent directory, mixed successes/failures, mixed entry types.

---

### Task 2.4: Implement validateSkillStructure with tests

**Size**: Small
**Priority**: Medium
**Dependencies**: 1.6
**Can run parallel with**: 2.1, 2.2

Implement `packages/skills/src/validator.ts` — `validateSkillStructure(dirPath)` that checks:

1. Directory name is a valid slug.
2. SKILL.md file exists.

Returns `ValidationResult` with `valid`, `errors[]`, `warnings[]`.

Tests in `validator.test.ts`: 4 test cases — valid structure, missing SKILL.md, invalid directory name, multiple errors.

---

### Task 2.5: Run Phase 2 gate and update CLAUDE.md monorepo structure

**Size**: Small
**Priority**: High
**Dependencies**: 2.1, 2.2, 2.3, 2.4
**Can run parallel with**: None

Run the full Phase 2 gate:

```bash
pnpm --filter @dorkos/skills typecheck && pnpm --filter @dorkos/skills build && pnpm --filter @dorkos/skills test -- --run
pnpm typecheck && pnpm build && pnpm test -- --run
```

Update `CLAUDE.md` to add `packages/skills/` to the monorepo structure section.

Final verification: no temp files, dead code, or TODOs remain.

---

## Dependency Graph

```
Phase 1:
  1.1 ─┬─→ 1.2 ──┐
       ├─→ 1.3 ──┤
       ├─→ 1.4 ──┤
       └─→ 1.5 ──┴─→ 1.6

Phase 2:
  1.6 ─┬─→ 2.1 ──→ 2.3 ──┐
       ├─→ 2.2 ───────────┤
       └─→ 2.4 ───────────┴─→ 2.5
```

## Summary

| Metric        | Value |
| ------------- | ----- |
| Total tasks   | 11    |
| Phase 1 tasks | 6     |
| Phase 2 tasks | 5     |
| Small tasks   | 4     |
| Medium tasks  | 7     |
| Large tasks   | 0     |

**Parallel opportunities:**

- Phase 1: Tasks 1.2, 1.3, 1.4 can all run in parallel after 1.1. Task 1.5 can run parallel with 1.3 (depends on 1.2 + 1.4).
- Phase 2: Tasks 2.1, 2.2, 2.4 can all run in parallel after 1.6. Task 2.3 depends on 2.1.

**Critical path:** 1.1 → 1.2 → 1.5 → 1.6 → 2.1 → 2.3 → 2.5
