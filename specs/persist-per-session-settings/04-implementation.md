# Implementation Summary: Persist Per-Session Settings in the API Core via a Narrow Port

**Created:** 2026-06-08
**Last Updated:** 2026-06-08
**Spec:** specs/persist-per-session-settings/02-specification.md

## Progress

**Status:** Complete (all 9 tasks done; both bugs reproduced-as-fixed live)
**Tasks Completed:** 9 / 9

## Tasks Completed

### Session 1 - 2026-06-08

- Task #1 (1.1): Add 5 nullable session-settings columns + Drizzle migration `0015_lyrical_union_jack.sql`
- Task #2 (1.2): Add `SessionSettings` schema, `SessionSettingsPort`, and `permissionModes.default` capability field (made **optional** — avoids churning ~12 unrelated `permissionModes` literals incl. `supported:false` cases)
- Task #3 (2.1): `getSessionSettings`/`saveSessionSettings`/`getSessionSettingsMany` on `RuntimeRegistry` (UPSERT resolves runtime for `NOT NULL`); `inArray` re-exported from `@dorkos/db`; 8 unit tests (38 total pass)
- Task #4 (2.2): widened `SessionOpts`/`MessageOpts` to `extends SessionSettings`; `SessionStore.configureSettings`; hydrate in `ensureForMessage` (opts → persisted → runtime default); seed all five in `ensureSession`; write-through (persist-first) in `updateSession`; `claude-code-runtime.setSessionSettings` forwarding; `default` on both capability constants; wired in `index.ts`
- Task #6 (2.4): `applyStoredSettings` overlay helper in `routes/sessions.ts`; `GET /:id` (single) + `GET /` (batch `getSessionSettingsMany`) overlay store over transcript; updated the route-test `runtimeRegistry` mock
- Task #5 (2.3): `message-sender.ts` sets `allowDangerouslySkipPermissions` unconditionally; `updateSession` live switch best-effort (no revert/re-throw); removed dead 422 `PERMISSION_MODE_FAILED` path in PATCH route; updated/removed obsolete tests asserting old revert/422 behavior
- Task #7 (3.1): new `session-store-settings.test.ts` (7 tests: cold-hydration regression, all-five hydration, precedence, default fallback, no-persist-on-override, write-through, port-optional); display-overlay route test (store wins); updated existing default-passthrough test to assert always-on flag. Full server suite **2627 passing / 1 skipped / 0 failed**; client + shared + db typecheck clean; 0 lint errors.
- Task #9 (4.1): TSDoc on `SessionSettingsPort`, registry store methods, `configureSettings`, `setSessionSettings`, `applyStoredSettings`; "Per-Session Settings Persistence" section added to `contributing/architecture.md`; ADR-0260 and ADR-0261 flipped to `accepted` (file frontmatter + Status + manifest).

### Files Modified/Created (cumulative)

- `packages/db/src/schema/sessions.ts`, `drizzle/0015_lyrical_union_jack.sql` (+meta), `packages/db/src/index.ts` (`inArray` re-export)
- `packages/shared/src/schemas.ts`, `types.ts`, `agent-runtime.ts`
- `apps/server/src/services/core/runtime-registry.ts` (+ `__tests__/runtime-registry.test.ts`)
- `apps/server/src/services/runtimes/claude-code/sessions/session-store.ts` (+ `__tests__/session-store-settings.test.ts`, `session-store-update.test.ts`)
- `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts`
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` (+ `__tests__/claude-code-runtime-interactive.test.ts`)
- `apps/server/src/services/runtimes/claude-code/runtime-constants.ts`, `test-mode/runtime-constants.ts`
- `apps/server/src/routes/sessions.ts` (+ `__tests__/sessions.test.ts`)
- `apps/server/src/index.ts`
- `contributing/architecture.md`, `decisions/0260-*.md`, `decisions/0261-*.md`, `decisions/manifest.json`

### Task #8 — manual live reproduction (DONE — both bugs confirmed fixed live)

Reproduced end-to-end against the dogfood dev server (`:6241`, committed code + migrated DB) on 2026-06-08, session `27da8b95`:

1. **Bug 1 — durability across restart (the reported bug):** set the session to Bypass (write-through persisted `permission_mode=bypassPermissions` to `session_metadata`, verified via `sqlite3 apps/server/.temp/.dork/dork.db`), restarted the dev server (in-memory cache wiped), then sent Write+Bash+delete → **no approval prompt** ("Done. File created, verified with ls, and deleted."). The runtime hydrated bypass from the store on the cold path instead of reverting to `default`; the toolbar showed Bypass after restart (GET overlay). Network: `POST /messages → 200` with **no `/approve` or `/deny` calls**.
2. **Bug 2 — instant live switch (the 422):** with the agent actively paused on a tool approval (Default mode, active query), `PATCH {permissionMode: bypassPermissions}` → **HTTP 200** (returned `"permissionMode":"bypassPermissions"`) where the old code threw **422 `PERMISSION_MODE_FAILED`**. Also switched mid-stream in the UI: no error toast, mode flipped to Bypass, network PATCH `[200]`, zero 422s.

Write-through and the GET overlay verified directly (DB row + API response). No leftover test files in `temp/empty`.

## Files Modified/Created

**Source files:**

- `packages/db/src/schema/sessions.ts` — 5 nullable settings columns + column-group comments
- `packages/db/drizzle/0015_lyrical_union_jack.sql` — additive `ADD COLUMN` migration (new)
- `packages/db/drizzle/meta/_journal.json`, `meta/0015_snapshot.json` — drizzle meta (new/updated, Prettier-clean)
- `packages/shared/src/schemas.ts` — `SessionSettingsSchema`/`SessionSettings`; `UpdateSessionRequestSchema` refactored to extend it
- `packages/shared/src/types.ts` — re-export `SessionSettings`
- `packages/shared/src/agent-runtime.ts` — `SessionSettingsPort`, `setSessionSettings?`, `permissionModes.default`

**Test files:**

_(None yet)_

## Known Issues

- `pnpm --filter @dorkos/db db:check` shows a trailing-newline diff on `meta/_journal.json` (drizzle-kit emits no trailing newline; the repo commits Prettier-formatted drizzle meta). Pre-existing conflict affecting every migration, not introduced here. Generated files are committed Prettier-clean to match the established convention.
- Expected transient compile break after Batch 1: `runtime-constants.ts` (claude-code + test-mode) miss the new required `permissionModes.default`. Resolved in Task #4 (Batch 3).

## Implementation Notes

### Session 1

Executing directly in dependency order (critical path is mostly sequential; an intentional transient compile break spans tasks 1.2→2.2). Batch-level gates: `pnpm typecheck`/`pnpm lint`/`pnpm test` run after the implementation batches land green, not per-task.

Batches:

- Batch 1: #1, #2 (Foundation — disjoint: `packages/db` vs `packages/shared`)
- Batch 2: #3 (core store)
- Batch 3: #4, #6 (disjoint files: runtime/index vs routes)
- Batch 4: #5 (always-on flag + best-effort switch)
- Batch 5: #7 (test suite), #8 (manual repro)
- Batch 6: #9 (docs + flip ADRs)
