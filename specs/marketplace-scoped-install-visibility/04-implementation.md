# Implementation Summary: Marketplace: Cross-Scope Install Visibility & Per-Agent Management

**Created:** 2026-07-02
**Last Updated:** 2026-07-02
**Spec:** specs/marketplace-scoped-install-visibility/02-specification.md

## Progress

**Status:** In Progress
**Tasks Completed:** 1 / 6

## Session

- **Workspace:** existing worktree `.claude/worktrees/marketplace-scoped-install-visibility`, branch `worktree-marketplace-scoped-install-visibility` (base `ec79a13b` = origin/main after PR #71). Phase 0 detected an existing secondary worktree — execute in place, no new worktree created.
- **Pre-existing work:** Phase 1 core was implemented + browser-verified before EXECUTE (commits `9c27905d` runtime, `0d94b2f7` API+UI, `da7310da` SPECIFY, `58b809e6` DECOMPOSE). EXECUTE covers the two remaining Phase-1 tasks (docs + ship) and the four Phase-2 follow-ups.

## Tasks Completed

### Session 1 - 2026-07-02

- Task #63 (1.1): Write cross-scope install docs (contributing + user docs)

## Files Modified/Created

**Source files:**

- `contributing/marketplace-installs.md` — added ADR-0305/0306 links, patched the two `/installed` rows in the §10 HTTP API table, added §16 "Cross-scope install visibility" (scan model, API, per-cwd activation, deliberate non-goals).
- `docs/marketplace.mdx` — added scope-picker note to the "Review and install" step, added "Managing installed packages" section (per-scope rows, Reinstall/Uninstall/Install…, override badge, extensions-are-global callout).

**Test files:**

_(None — docs-only task)_

## Known Issues

- Stage-1 accuracy review: the first Explore agent audited the **main checkout** (no branch commits) instead of this worktree and produced false "unimplemented" findings — the known subagent worktree-path trap. Re-verified every doc claim directly against the worktree source; all accurate (`scanInstallationsAcrossScopes:173`, `{ installations }:341`, `listPackageInstallations:818`, `listAgentScopes:719`, `resolvePluginsForCwd`/`clearSdkCommands`). Watch for this on any later subagent dispatch — pass and confirm worktree-absolute paths.

## Implementation Notes

### Session 1

- Phase 1 core was already implemented + browser-verified before EXECUTE (commits `9c27905d`, `0d94b2f7`). Task 1.1 documents that shipped behavior; docs verified line-by-line against the worktree, prettier-clean.
