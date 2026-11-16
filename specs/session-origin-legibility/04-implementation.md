---
slug: session-origin-legibility
created: 2026-07-21
last-updated: 2026-07-21
---

# Implementation Summary — Session origin legibility

**Status:** Complete
**Spec:** specs/session-origin-legibility/02-specification.md
**Tracker:** DOR-408

## Progress

Tasks Completed: 16 / 16

## Session

- Worktree: `/Users/doriancollier/.dork/workspaces/dorkos/spec-session-origin-legibility` (branch `spec-session-origin-legibility`, based on origin/main @ 9bc1a9acd, ports 4329/4479)
- Orchestrator: Claude (Fable); implementation agents (all Sonnet): Mason (P1 server, tasks 1.1–1.6), Iris (client foundation + rows, 2.1–2.5), Wren (sidebar filtering + header + changelog, 2.6–2.9 + playground)
- Review: independent REVIEW.md pass by a fresh code-reviewer agent pre-PR

### Session 1 - 2026-07-21

- Task 1.1: SessionOrigin schema + origin/originLabel on SessionSchema (also re-exported SessionOrigin from @dorkos/shared/types)
- Task 1.2: classifyOrigin pure classifier + 18 table-driven tests incl. formatPromptWithContext coupling fixture
- Task 1.3: extractSessionMeta hook (firstRawUserMessage capture) + transcript-reader test extensions
- Task 1.4: Pulse task-origin overlay — TaskStore.resolveTaskOrigins (batched IN query), applyTaskOriginOverlay, wired via app.locals at composition root into GET /api/sessions and GET /api/sessions/:id
- Task 1.5: test-utils factory passthrough confirmed (no functional change; TSDoc note)
- Task 1.6: OpenAPI snapshot regenerated via `pnpm docs:export-api` (idempotent)
- Task 2.1: origin-descriptors.ts registry (no `user` entry; getOriginDescriptor undefined for user/unknown)
- Task 2.2: OriginMark.tsx (render-null for user/absent/unknown; muted 12px tooltip mark)
- Task 2.3: partitionSessionsByOrigin pure selector + tests
- Task 2.4: entities/session barrel exports
- Task 2.5: OriginMark on SessionRowCompact, RecentSessionRow, SessionRowFull + detail-panel Origin line
- Task 2.6: AgentListItem conversations-first preview + "+ N automated" reveal (partition before slice)
- Task 2.7: RecentSessionsSection conversations-first + reveal; helpers extracted for shared agent lookup
- Task 2.8: Session header origin chip — new useSessionOrigin hook mirroring useSessionRuntime (no new fetch), threaded through useHeaderSlot into SessionHeader breadcrumb
- Task 2.9: single consolidated plain-language changelog fragment (six auto-generated fragments folded into one)
- Extra: dev playground — two origin-varied session mocks in SidebarShowcases

## Files Modified/Created

Server/shared:

- packages/shared/src/schemas.ts, packages/shared/src/types.ts
- apps/server/src/services/runtimes/claude-code/sessions/classify-origin.ts (+ **tests**/classify-origin.test.ts)
- apps/server/src/services/runtimes/claude-code/sessions/transcript-reader.ts
- apps/server/src/services/session/**tests**/transcript-reader.test.ts
- apps/server/src/services/session/task-origin-overlay.ts (+ **tests**/task-origin-overlay.test.ts), services/session/index.ts
- apps/server/src/services/tasks/task-store.ts (+ resolveTaskOrigins tests in task-store.test.ts)
- apps/server/src/index.ts, apps/server/src/routes/sessions.ts
- packages/test-utils (TSDoc note on createMockSession)
- OpenAPI snapshot (docs:export-api output)

Client:

- apps/client/src/layers/entities/session/config/origin-descriptors.ts (new)
- apps/client/src/layers/entities/session/ui/OriginMark.tsx (+ tests) (new)
- apps/client/src/layers/entities/session/lib/partition-sessions-by-origin.ts (+ tests) (new)
- apps/client/src/layers/entities/session/model/use-session-origin.ts (new)
- apps/client/src/layers/entities/session/{index.ts, ui/SessionRowCompact.tsx, ui/SessionRowFull.tsx, **tests**/SessionRow.test.tsx}
- apps/client/src/layers/features/dashboard-sidebar/{ui/AgentListItem.tsx, ui/RecentSessionsSection.tsx, ui/RecentSessionRow.tsx, **tests**/AgentListItem.test.tsx, **tests**/RecentSessionsSection.test.tsx (new), **tests**/RecentSessionRow.test.tsx (new), **tests**/DashboardSidebar.test.tsx}
- apps/client/src/layers/features/top-nav/ui/SessionHeader.tsx (+ **tests**/SessionHeader.test.tsx), apps/client/src/AppShell.tsx
- apps/client/src/dev/showcases/SidebarShowcases.tsx
- changelog/unreleased/260721-161620-render-originmark-on-session-rows-and-th.md (consolidated fragment)

## Known Issues

- Commit `a11e54f3e` is mislabeled (near-empty; its intended content landed in `2ebdd0201` under the same message) — a `git add` multi-path no-op. Harmless; disappears on squash-merge.
- DashboardSidebar.test.tsx's wholesale entities/session mock was stale after task 2.5 (missing OriginMark/partitionSessionsByOrigin); fixed by Wren in-scope.

## Follow-ups (file at DONE)

- Sidechain/subagent transcripts are never filtered from session lists (adjacent gap; ideation decision 9).
- Channel sender identity (senderName) captured on inbound but never forwarded to prompt/UI (ideation decision 9).
- Optional hardening: creation-time origin stamp in session_metadata (ADR 260721-153851 consequences).
