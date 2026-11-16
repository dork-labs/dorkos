# Tasks — Persist Per-Session Settings in the API Core via a Narrow Port

- **Spec:** `specs/persist-per-session-settings/02-specification.md`
- **Slug:** `persist-per-session-settings`
- **Mode:** full
- **Generated:** 2026-06-08
- **Total tasks:** 9 across 4 phases

The spec lists 8 ordered implementation steps; they are grouped here into Foundation → Core → Testing → Documentation. Each task is self-contained — full file paths, the verbatim code to add/change, and acceptance + verification commands live in `03-tasks.json`. This file is the human-readable index.

---

## Phase 1 — Foundation

Contract + schema. The two tasks are independent and run in parallel.

### 1.1 — Add 5 nullable session-settings columns + Drizzle migration

`packages/db/src/schema/sessions.ts` + generated `packages/db/drizzle/0015_*.sql`.

Add `permission_mode` (text), `model` (text), `effort` (text), `fast_mode` (integer `{ mode: 'boolean' }`), `auto_mode` (integer `{ mode: 'boolean' }`) to `session_metadata`, all nullable. Import `integer`. Keep the column-group comments (immutable identity / mutable settings; `NULL = runtime default`). Run `pnpm --filter @dorkos/db db:generate`, commit `0015_*.sql` + meta snapshot, verify with `db:check`. Migration is purely additive and auto-applies via `migrate()` at boot.

- Size: small · Priority: high · Depends on: — · Parallel with: 1.2

### 1.2 — Add SessionSettings schema, SessionSettingsPort, capability default

`packages/shared/src/schemas.ts` + `packages/shared/src/agent-runtime.ts`.

Add `SessionSettingsSchema` + `SessionSettings` type; refactor `UpdateSessionRequestSchema` to `SessionSettingsSchema.extend({ title })` (keep `.openapi(...)`). Add `SessionSettingsPort` interface and optional `AgentRuntime.setSessionSettings?(port)`. Add required `default: string` to `RuntimeCapabilities.permissionModes`. (Intentionally leaves the two capability constants failing typecheck until 2.2.)

- Size: small · Priority: high · Depends on: — · Parallel with: 1.1

---

## Phase 2 — Core

### 2.1 — Implement session-settings store on RuntimeRegistry + unit tests

`apps/server/src/services/core/runtime-registry.ts` + `__tests__/runtime-registry.test.ts`.

Implement `getSessionSettings` (NULL→omitted), `saveSessionSettings` (UPSERT, infers runtime, `onConflictDoUpdate({ set: patch })`, no-op on empty patch), and `getSessionSettingsMany(ids)` (single `inArray` query → `Map`). Unit tests cover UPSERT create/update, identity-preservation on conflict, NULL mapping, boolean round-trip, batch read.

- Size: medium · Priority: high · Depends on: 1.1, 1.2 · Parallel with: —

### 2.2 — Hydrate + write-through in claude-code runtime; wire port; seed all five

`agent-runtime.ts` (widen `SessionOpts`/`MessageOpts`), `session-store.ts` (`configureSettings`, hydrate in `ensureForMessage`, seed five in `ensureSession`, persist-first in `updateSession`), `claude-code-runtime.ts` (`setSessionSettings` forwarding), both `runtime-constants.ts` (`default: 'default'` / `default: 'always-allow'`), `index.ts` (`claudeRuntime.setSessionSettings(runtimeRegistry)` near the `setMeshCore` wiring).

Precedence on hydrate: `opts → persisted → runtime default`. Write-through persists before mutating in-memory state. (Best-effort live-switch / no-revert is owned by 2.3.)

- Size: large · Priority: high · Depends on: 1.1, 1.2, 2.1 · Parallel with: —

### 2.3 — Always-on bypass capability + best-effort live mode switch (ADR-0261)

`message-sender.ts` (set `allowDangerouslySkipPermissions = true` unconditionally; drop the `if (… === 'bypassPermissions')` guard at lines 235-238), `session-store.ts` (`updateSession` no longer reverts `prevMode` or re-throws on live-apply failure — swallow + log), `sessions.ts` (remove the now-dead 422 `PERMISSION_MODE_FAILED` try/catch around `updateSession`). Warm-up `query()` in `runtime-cache.ts:184` is untouched.

- Size: medium · Priority: high · Depends on: 2.2 · Parallel with: 2.4

### 2.4 — Overlay persisted settings in GET /:id and GET / route handlers

`apps/server/src/routes/sessions.ts`.

`GET /:id` overlays `runtimeRegistry.getSessionSettings(id)` (async) over transcript-derived values. `GET /` overlays `runtimeRegistry.getSessionSettingsMany(ids)` (sync `Map`, single query, no N+1). Store wins; legacy rows fall back to transcript without error. Extract the five-field overlay into a local helper (DRY).

- Size: medium · Priority: high · Depends on: 2.1 · Parallel with: 2.3

---

## Phase 3 — Testing

### 3.1 — Full test suite

RuntimeRegistry store, hydration regression (cold path with persisted bypass → in-memory bypass), precedence, write-through (changed fields only; per-send override does not persist), display overlay, cross-runtime (optional port; foreign mode → runtime default), flag-inertness regression (ADR-0261), instant live-switch (no 422/revert; swallowed failure), migration `db:check`. Each test carries a purpose comment; follows `.claude/rules/testing.md`.

- Size: large · Priority: high · Depends on: 2.1, 2.2, 2.3, 2.4 · Parallel with: 3.2

### 3.2 — Manual reproduction of both fixed bugs

Repro 1: set bypass → wait past 30-min eviction OR restart dev server → send a write → confirm NO prompt. Repro 2: switch an active session to bypass → confirm no 422 and instant effect. Optionally confirm the persisted `session_metadata` row.

- Size: small · Priority: medium · Depends on: 2.1, 2.2, 2.3, 2.4 · Parallel with: 3.1

---

## Phase 4 — Documentation

### 4.1 — TSDoc, contributing guide note, flip ADR-0260/0261 to accepted

Verify/add TSDoc on `SessionSettingsPort`, the new `RuntimeRegistry` methods, and the schema column groups. Add the "core owns session-settings persistence via a narrow port" pattern to `contributing/architecture.md` (or the runtime/session guide). Flip ADR-0260 and ADR-0261 `proposed → accepted` (and `decisions/manifest.json`) after 3.1 + 3.2 verify the behavior.

- Size: small · Priority: medium · Depends on: 3.1 · Parallel with: —

---

## Execution graph

```
Phase 1 (parallel):   1.1 ─┐        1.2 ─┐
                           │             │
Phase 2:        2.1 ◀──────┴─────────────┘   (needs 1.1 + 1.2)
                 │
                 ├──▶ 2.2 (needs 1.1,1.2,2.1)
                 │      │
                 │      └──▶ 2.3 ─┐  (parallel with 2.4)
                 └──────────▶ 2.4 ─┘  (needs 2.1)
                                  │
Phase 3:        3.1 ◀─────────────┘   (needs 2.1–2.4)   ‖ 3.2 (parallel)
                 │
Phase 4:        4.1 ◀─────────────────┘   (needs 3.1)
```

**Critical path:** 1.1/1.2 → 2.1 → 2.2 → 2.3 → 3.1 → 4.1 (six sequential hops).

**Parallel opportunities:** 1.1 ‖ 1.2 (Foundation); 2.3 ‖ 2.4 (both Core, after 2.2/2.1 respectively); 3.1 ‖ 3.2 (Testing).
