# Implementation Summary: Additional Agent Runtimes: OpenCode + Codex

**Created:** 2026-07-02
**Last Updated:** 2026-07-02
**Spec:** specs/additional-agent-runtimes/02-specification.md

## Session

**Worktree:** `~/.dork/workspaces/dorkos/DOR-180` (branch `DOR-180`, based on origin/main @ ec79a13b)
**Tracker:** DOR-180

## Progress

**Status:** In Progress
**Tasks Completed:** 4 / 27

## Tasks Completed

### Session 1 - 2026-07-02

- Task 1.1 (#6): Add Session.runtime field and 'opencode' to the runtime enum
- Task 1.2 (#7): Add runtimes.\* user-config block with a semver conf migration ('0.47.0' placeholder)
- Task 1.5 (#10): Build the runtimeConformance shared Vitest suite (16 tests, test-mode + mocked claude-code)
- Task 1.6 (#11): RuntimeDescriptor client registry, OpenCode/Codex icons, RuntimeMark on session rows

## Files Modified/Created

**Source files:**

- `packages/shared/src/schemas.ts` (Session.runtime required), `packages/shared/src/mesh-schemas.ts` ('opencode' + dual-use TSDoc), `packages/shared/src/config-schema.ts` (runtimes.\* block)
- `apps/server/src/services/core/config-manager.ts` (backfillRuntimesDefaults @ '0.47.0')
- `apps/server/src/services/runtimes/claude-code/sessions/transcript-reader.ts`, `apps/server/src/services/runtimes/test-mode/session-registry.ts` (runtime tagging)
- `packages/icons/src/adapter-logos.tsx` (OpenCodeLogo, CodexLogo)
- `apps/client/src/layers/entities/runtime/` (runtime-descriptors.ts, RuntimeMark.tsx, barrel), `entities/session/ui/SessionRow{Full,Compact}.tsx`, `features/agent-hub/ui/tabs/ConfigTab.tsx` (RUNTIME_LABELS deleted)
- `apps/client/src/layers/features/chat/model/use-session-submit.ts` (optimistic session runtime placeholder)
- `packages/test-utils/src/mock-factories.ts`, `packages/test-utils/src/runtime-conformance.ts` (+ index barrel)

**Test files:**

- `packages/shared/src/__tests__/schemas.test.ts`, `mesh-schemas.test.ts`, `config-schema.test.ts`
- `apps/server/src/services/core/__tests__/config-manager.test.ts`
- `apps/server/src/services/runtimes/{test-mode,claude-code}/__tests__/conformance.test.ts` (NEW)
- `apps/client`: entities/runtime tests (NEW), SessionRow.test.tsx, SessionsView.test.tsx (NEW), ConfigTab.test.tsx + 9 fixture updates

## Known Issues

- Reviewer minors carried forward: routes/sessions.ts:221 loose fallback omits `runtime` on the wire (task 1.3 owns the fix); optimistic row hardcodes 'claude-code' at use-session-submit.ts:157 (task 1.8 threads the real hint); ConfigTab label fallback renders raw slug for discovery-only runtimes (acceptable per spec).
- Full-suite flakes dispositioned at the Batch 1 gate (pass in isolation): marketplace.test.ts install happy-path (5s timeout under load); known pre-existing: extension-proxy wildcard case, session-list-watcher.integration.

## Implementation Notes

### Session 1

Execution plan (derived from 03-tasks.json dependency DAG; analysis agent skipped — first session, DAG already validated at DECOMPOSE):

- Batch 1: 1.1, 1.2, 1.5, 1.6 (no dependencies)
- Batch 2: 1.3, 1.4, 1.7, 1.8, 2.1 — then 3.1 sequenced after 2.1 (both mutate apps/server/package.json + pnpm-lock + packages/eslint-config)
- Batch 3: 2.2, 2.3, 2.4, 3.2
- Batch 4: 2.5, 3.4, 3.5, 4.1, 4.3 — then 3.3 sequenced after 2.5 (both mutate apps/server/src/index.ts)
- Batch 5: 2.6, 3.6
- Batch 6: 3.7, 4.2, 4.4, 4.5
- Batch 7: 4.6

Review model: holistic batch-level gate (typecheck + affected tests + code review on the batch diff), per repo feedback memory — not per-task two-stage review. Orchestrator commits at each gate; agents never commit.
