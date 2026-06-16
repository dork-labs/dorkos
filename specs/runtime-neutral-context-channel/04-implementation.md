# Implementation Summary: Runtime-Neutral Additional-Context Channel

**Created:** 2026-06-16
**Last Updated:** 2026-06-16
**Spec:** specs/runtime-neutral-context-channel/02-specification.md

## Worktree

- **Path:** `/Users/doriancollier/.dork/workspaces/core/spec-runtime-neutral-context-channel`
- **Branch:** `spec-runtime-neutral-context-channel` (forked from `main@ca3378bd`)
- **Ports:** DORKOS_PORT=4368 / VITE_PORT=4518 / SITE_PORT=4668
- **Cleanup after merge:** `/worktree:remove spec-runtime-neutral-context-channel --delete-branch`

## Progress

**Status:** In Progress
**Tasks Completed:** 1 / 12

## Tasks Completed

### Session 1 - 2026-06-16

- Task #10: [P1] Add `excludeDynamicSections: true` to Claude system prompt (DOR-132) — git de-dup; preset native git/cwd/memory suppressed, DorkOS `<git_status>` is now the sole source.

## Files Modified/Created

**Source files:**

- `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts` — `excludeDynamicSections: true` on the `claude_code` preset.

**Test files:**

- `apps/server/src/services/runtimes/claude-code/messaging/__tests__/message-sender-system-prompt.test.ts` (new) — asserts the built `systemPrompt` carries the flag.
- `apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts` — updated the exact-match `systemPrompt` assertion to include the flag.

## Known Issues

- **G1 (re-injection):** SDK re-injects stripped sections into the first user message (sdk.d.ts 1943-1944); under DorkOS resume-per-message a session-start git/cwd snapshot may briefly coexist with the fresh per-turn `<git_status>`. Tolerated per ADR-0273 A2 (stale-tolerant). No compensation.
- **G2 (env overlap):** `excludeDynamicSections` strips the preset's working-dir/auto-memory/git dynamic sections (not a tagged `<env>`), so there is no full `<env>` duplication — but the re-injected first-user-message snapshot restates `cwd`, overlapping DorkOS's `buildEnvBlock` `Working directory:` line. Flagged for Task #14 (assembler env-entry decision): drop the `Working directory:` line from `buildEnvBlock` or keep it authoritative.

## Implementation Notes

### Session 1

_(Implementation in progress)_
