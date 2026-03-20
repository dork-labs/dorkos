# Task Breakdown: Rename `apps/web` → `apps/site` & Fix CLAUDE.md Doc Drift

Generated: 2026-03-01
Source: specs/monorepo-naming-convention/02-specification.md
Last Decompose: 2026-03-01

## Overview

Rename the marketing/docs app from `apps/web` to `apps/site`, update all live documentation references, fix CLAUDE.md structure section to reflect the actual 5 apps + 7 packages, and verify nothing broke.

## Phase 1: Rename & Regenerate

### Task 1.1: Rename apps/web to apps/site and update package config

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None

**Implementation Steps**:

1. `git mv apps/web apps/site`
2. Update `apps/site/package.json` name from `@dorkos/web` to `@dorkos/site`
3. Update script comments in `apps/site/scripts/generate-api-docs.ts`
4. `pnpm install` to regenerate lockfile

**Acceptance Criteria**:

- [ ] `apps/site/` exists, `apps/web/` does not
- [ ] Package name is `@dorkos/site`
- [ ] Lockfile regenerates cleanly

## Phase 2: Update Live References

### Task 2.1: Update CLAUDE.md structure section and references

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.2

**Implementation Steps**:

1. Update count from "four apps and four shared packages" to "five apps and seven shared packages"
2. Replace ASCII tree to include all 5 apps and 7 packages (adding `e2e`, `db`, `relay`, `mesh`)
3. Update documentation section reference from `apps/web`/`@dorkos/web` to `apps/site`/`@dorkos/site`
4. Grep for any other `apps/web` or `@dorkos/web` references

**Acceptance Criteria**:

- [ ] Correct counts in structure heading
- [ ] Complete ASCII tree with all apps/packages
- [ ] No remaining `apps/web` or `@dorkos/web` references

### Task 2.2: Update remaining live documentation files

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.1

**Files to update**:

1. `CONTRIBUTING.md` — table row + add missing entries
2. `contributing/project-structure.md` — ASCII tree + add missing entries
3. `contributing/environment-variables.md` — table row
4. `docs/contributing/development-setup.mdx` — folder tree + table row
5. `.claude/agents/typescript/typescript-expert.md` — path reference
6. `apps/e2e/BROWSER_TEST_PLAN.md` — section header

**DO NOT update**: historical specs, research, plans, decisions

**Acceptance Criteria**:

- [ ] All 6 files updated
- [ ] Missing packages/apps added where appropriate
- [ ] Historical artifacts untouched

## Phase 3: Verification

### Task 3.1: Verify builds, typecheck, and lint pass

**Size**: Small
**Priority**: High
**Dependencies**: Task 2.1, Task 2.2
**Can run parallel with**: None

**Verification Commands**:

1. `pnpm install`
2. `turbo build --filter=@dorkos/site`
3. `pnpm typecheck`
4. `pnpm lint`
5. `pnpm test -- --run`
6. Grep verification — no `@dorkos/web` in live files

**Acceptance Criteria**:

- [ ] All commands pass
- [ ] No stale references in live code/config/docs
