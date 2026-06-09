# Implementation Summary: Auto Mode — Remove the Misplaced Toggle, Adopt Auto as a Permission Mode

**Created:** 2026-06-09
**Last Updated:** 2026-06-09
**Spec:** specs/auto-permission-mode/02-specification.md

## Progress

**Status:** Complete — both phases shipped, live walkthrough passed, 2 post-walkthrough follow-ups landed
**Tasks Completed:** 12 / 12 + 2 follow-ups

## Tasks Completed

### Session 1 - 2026-06-09 (Phase 1 — Cleanup)

- Task #1: Remove `autoMode` from shared schemas, agent-runtime opts, and test-utils fixtures
- Task #2: Drop the `auto_mode` DB column and generate the drizzle DROP migration
- Task #3: Remove `autoMode`/`disableAutoMode` server plumbing (routes, registry, agent-types, session-store, runtime, message-sender, test-mode)
- Task #4: Remove `autoMode` client plumbing — Model Config Mode section is now Fast-only (use-session-status, ChatStatusSection)
- Task #5: Update affected tests; typecheck + lint + targeted vitest green

## Files Modified/Created

**Source files:**

- `packages/shared/src/schemas.ts` — removed `autoMode` from `SessionSchema` + `SessionSettingsSchema` (kept `PermissionModeSchema.'auto'`)
- `packages/shared/src/agent-runtime.ts` — removed `autoMode?` from `updateSession` opts
- `packages/db/src/schema/sessions.ts` — removed the `auto_mode` column
- `packages/db/drizzle/0016_previous_ronan.sql` (new) — `ALTER TABLE session_metadata DROP COLUMN auto_mode;`
- `packages/db/drizzle/meta/0016_snapshot.json` (new) + `meta/_journal.json` (idx 16)
- `apps/server/src/routes/sessions.ts`
- `apps/server/src/services/core/runtime-registry.ts`
- `apps/server/src/services/runtimes/claude-code/agent-types.ts`
- `apps/server/src/services/runtimes/claude-code/sessions/session-store.ts`
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`
- `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts` — dropped the `disableAutoMode` branch (block is now `if (session.fastMode)`)
- `apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts`
- `apps/client/src/layers/features/status/ui/ModelConfigPopover.tsx` — Mode section Fast-only
- `apps/client/src/layers/entities/session/model/use-session-status.ts`
- `apps/client/src/layers/features/chat/ui/status/ChatStatusSection.tsx`

**Test files:**

- `apps/server/src/services/core/__tests__/runtime-registry.test.ts`
- `apps/server/src/services/runtimes/claude-code/__tests__/session-store-settings.test.ts`
- `apps/server/src/routes/__tests__/sessions.test.ts`
- `apps/client/src/layers/features/status/__tests__/ModelConfigPopover.test.tsx`
- `packages/test-utils/src/fake-agent-runtime.ts` (kept the `'auto'` permission-mode descriptor in the capabilities mock — distinct from the removed toggle)

## Known Issues

_(None)_

## Verification (Phase 1, batch-level)

- `pnpm typecheck` — pass (21/21)
- `pnpm lint` — pass (16/16, 0 errors)
- Targeted vitest — server 92 tests (session-store-settings, runtime-registry, sessions) + client 63 tests (ModelConfigPopover 35, use-session-status guard, siblings) — all pass
- `grep autoMode\b` (excl. `supportsAutoMode`) and `grep disableAutoMode` over `apps`/`packages` — both empty
- Guardrails intact: `supportsAutoMode` plumbing (`runtime-cache.ts:73,84`) and `PermissionModeSchema.'auto'` preserved
- Migration: single clean `DROP COLUMN auto_mode` (no SQLite table rewrite; no other columns lost)

## Implementation Notes

### Session 1

Phase 1 (tasks #1–#5) executed as one atomic `autoMode`/`disableAutoMode` removal via an
isolated implementation agent, then verified at the batch level (the codebase only typechecks
once every reference is gone, so per-task verification isn't meaningful). `supportsAutoMode`
plumbing and `PermissionModeSchema.'auto'` are deliberately preserved for Phase 2.

### Session 2 - 2026-06-09 (Phase 2 — Adoption)

Adopted `'auto'` as a model-gated permission mode. Executed in two coherent batches
(server, then client) via isolated agents, verified at the batch level + full suite.

**Tasks completed**

- Task #6: Added the `'auto'` descriptor to `CLAUDE_CODE_CAPABILITIES.permissionModes.values` (`runtime-constants.ts`).
- Task #7 (safety-critical): `interactive-handlers.ts:237` gate now treats `'auto'` like `'default'` → the classifier's interactive fallback renders approval cards instead of silently auto-allowing. New `messaging/__tests__/interactive-handlers.test.ts`.
- Task #8: New `permission_denied` StreamEvent — `StreamEventTypeSchema` + `PermissionDeniedEventSchema` + union in `packages/shared/src/schemas.ts` (+ `types.ts` re-export); mapped SDK `system/permission_denied` in `system-event-mapper.ts` (+ `sdk-event-mapper.test.ts`). `capabilities.test.ts` updated for the 5th mode.
- Task #9: Per-model gating — `ChatStatusSection` derives `modelSupportsAutoMode` (`useModels` × `status.model`) and passes it to `PermissionModeItem`, which hides `'auto'` (with an explanatory tooltip) when unsupported.
- Task #10: Once-per-session confirmation — `AutoModeConfirmDialog` + per-session `autoConfirmedSessions` state in `session-chat-store`; `ChatStatusSection.handleChangeMode` intercepts `'auto'` and gates the first switch per session.
- Task #11: Denial chip — `case 'permission_denied'` in `stream-event-handler.ts` → `PermissionDeniedPart` (new `MessagePartSchema` member) → `PermissionDeniedChip`; plus a "Preview" tag on the Auto option. Dev playground showcase added in `MessageShowcases.tsx`.

**Phase 2 files (added to the list above):** `runtime-constants.ts`, `interactive-handlers.ts` (+test), `system-event-mapper.ts` (+`sdk-event-mapper.test.ts`), `capabilities.test.ts`, `packages/shared/src/schemas.ts` + `types.ts`, `PermissionModeItem.tsx`, `ChatStatusSection.tsx` (+`__tests__`), `session-chat-store.ts`, `AutoModeConfirmDialog.tsx` (new), `stream-event-handler.ts` + `stream-event-types.ts`, `PermissionDeniedChip.tsx` (new), `AssistantMessageContent.tsx`, `MessageShowcases.tsx`, barrels.

**Phase 2 verification (#12 automated gates — all green):**

- `pnpm typecheck` (21/21), `pnpm lint` (16/16, 0 errors)
- `pnpm test -- --run` (authoritative): all packages green — client 358 files, server 178 files. (Note: under a _bare_ `pnpm vitest run`, two unrelated `import.meta.env.DEV` error-fallback tests report false failures; they pass under the turbo+dotenv command the pre-push hook uses.)
- New/updated suites: interactive-handlers fallback, system-event-mapper `permission_denied`, PermissionModeItem gating + preview, ChatStatusSection auto-mode, session-chat-store confirmation, PermissionDeniedChip.

**Deviation:** per-session confirmation state uses `Record<string, true>` rather than a `Set` (immer MapSet plugin isn't enabled in the store); behavior is identical.

### Session 3 - 2026-06-09 (Live walkthrough + follow-ups)

**#12 live-dev walkthrough — PASSED.** On the isolated `:6242` dev server (Playwright MCP): `'auto'` shows on the default (Opus 4.8) model with Sparkles + red danger tint + "Preview"; the Mode section is Fast-only (Phase 1); the confirmation modal opens on first select and gates the change; Confirm applies it; re-selecting in the same session does not re-prompt; switching to Haiku hides `'auto'`. Report: `test-results/chat-self-test/20260609-105557-auto-permission-mode.md` (gitignored). The live classifier-denial chip wasn't triggered (non-deterministic) — covered by unit tests + playground.

**Follow-up 1 — runtime guard (the walkthrough's edge-case finding).** Switching an active-`auto` session to a non-supporting model (Haiku) left the session in `'auto'`, which would 400 on send. Handled in the **runtime** (the authoritative chokepoint), per the agent-specific nature of model↔mode compatibility:

- New `messaging/permission-mode-guard.ts` `resolveEffectivePermissionMode()` — coerces `'auto'` → `'default'` only when `modelSupportsAutoMode === false` (never on `undefined`/uncertainty). Unit-tested (`permission-mode-guard.test.ts`, 7 tests).
- `message-sender.ts` applies it at query-construction time, mutates `session.permissionMode` so it doesn't repeat, and yields a `system_status` ("Auto mode isn't available on this model — using Default instead.").
- `claude-code-runtime.ts` resolves `modelSupportsAutoMode` from `cache.resolveModelCapability(session.model)` and threads it via `MessageSenderOpts`.

**Follow-up 2 — plain-language modal copy.** `AutoModeConfirmDialog` rewritten from a 3-paragraph "safety classifier" explanation to one plain sentence: "The agent runs on its own and only checks with you before risky actions — like deleting files or running unfamiliar commands. You can switch back anytime." Badge shortened to "Preview".

**Follow-up verification:** `pnpm typecheck` 21/21, `pnpm lint` 16/16, `permission-mode-guard` 7/7, `ChatStatusSection-auto-mode` 4/4.
