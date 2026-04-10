# Implementation Summary: Rename `apps/web` → `apps/site` & Fix AGENTS.md Doc Drift

**Created:** 2026-03-01
**Last Updated:** 2026-03-01
**Spec:** specs/monorepo-naming-convention/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 4 / 4

## Tasks Completed

### Session 1 - 2026-03-01

- Task #1.1: Rename apps/web to apps/site and update package config
- Task #2.1: Update AGENTS.md structure section and references
- Task #2.2: Update remaining live documentation files
- Task #3.1: Verify builds, typecheck, and lint pass

## Files Modified/Created

**Source files:**

- `apps/site/` — directory renamed from `apps/web/` via `git mv`
- `apps/site/package.json` — name changed to `@dorkos/site`
- `apps/site/scripts/generate-api-docs.ts` — updated comment references
- `pnpm-lock.yaml` — regenerated with new workspace path
- `AGENTS.md` — updated counts (5 apps + 7 packages), ASCII tree, doc section reference, build comment
- `CONTRIBUTING.md` — updated table row + added missing entries (e2e, db, relay, mesh)
- `contributing/project-structure.md` — updated ASCII tree + added missing entries
- `contributing/environment-variables.md` — updated table rows
- `docs/contributing/development-setup.mdx` — updated folder tree, table, counts
- `.claude/agents/typescript/typescript-expert.md` — updated path reference
- `apps/e2e/BROWSER_TEST_PLAN.md` — updated section header
- `.claude/hooks/typecheck-changed.sh` — updated stale apps/web reference (bonus)

**Test files:**

_(No test changes — rename-only spec)_

## Known Issues

_(None)_

## Verification Results

- `pnpm install` — succeeded
- `turbo build --filter=@dorkos/site` — Next.js build succeeded
- `pnpm typecheck` — all 13 packages pass
- `pnpm lint` — all 12 packages pass (0 errors)
- `pnpm test -- --run` — all tests pass
- `@dorkos/web` grep — only in historical artifacts (specs, decisions, plans)

## Implementation Notes

### Session 1

- Batch 1: Renamed directory, updated package.json, updated script comments, regenerated lockfile
- Batch 2 (parallel): Updated AGENTS.md + 6 other live docs + 1 bonus file (typecheck hook)
- Batch 3: Full verification suite passed
- Bonus: Agent 2.2 caught a stale `apps/web` reference in `.claude/hooks/typecheck-changed.sh`
- Note: Vercel dashboard "Root Directory" setting needs manual update from `apps/web` to `apps/site`
