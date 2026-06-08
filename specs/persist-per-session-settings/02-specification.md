# Persist Per-Session Settings in the API Core via a Narrow Port

## Status

Specified

## Authors

DorkOS agent — 2026-06-08

## Overview

Per-session settings (`permissionMode`, `model`, `effort`, `fastMode`, `autoMode`) currently live **only** on the in-memory `AgentSession` in the claude-code runtime. They are never persisted, so they silently reset whenever the in-memory session is discarded — on 30-minute idle eviction or on server restart (frequent while dogfooding). The user-visible symptom: a session the UI badges **"Permissions bypassed"** still prompts for tool approval, because the runtime reverted to `default`.

This spec makes the **API core layer** the single, authoritative owner of session-settings persistence, via a narrow port injected into runtimes. Runtimes become pure executors that hydrate from and write through to the store. Settings survive eviction and restart, all UI surfaces and the enforcement path read one source, and the fix is runtime-agnostic by construction so future runtimes (e.g. Codex) inherit it for free. Decision recorded in **ADR-0260**; extends **ADR-0255** (the `session_metadata` table).

It also fixes a second, related fault: switching an **actively-running** session to bypass throws a 422 and reverts, because the SDK only permits a live switch to `bypassPermissions` if the query was _launched_ with `allowDangerouslySkipPermissions`. We resolve this by always launching SDK queries with that flag — empirically verified to be **inert in non-bypass modes** — so mode changes (including → bypass) apply instantly mid-run. Recorded in **ADR-0261**.

## Background / Problem Statement

Traced behavior (verified in code, reproduced live in the browser):

1. **In-memory only.** `SessionStore.updateSession()` (`session-store.ts:176-200`) mutates `session.permissionMode/model/effort/fastMode/autoMode` on the in-memory `AgentSession`. Nothing is persisted.
2. **Eviction.** `checkSessionHealth()` (`session-store.ts:293-307`) `delete`s any session idle longer than `SESSIONS.TIMEOUT_MS` (30 min). Server restart wipes all in-memory sessions.
3. **Lossy re-creation.** The next message calls `ensureForMessage()` (`session-store.ts:86-119`), which recreates the session with `permissionMode` hardcoded to `'default'` (line 102) and `model/effort/fastMode/autoMode` left `undefined`. The client `sendMessage` body does **not** carry settings.
4. **Three divergent display sources.** The UI derives the displayed mode from the SDK JSONL transcript via `transcript-reader.ts`: the session-list **badge** reads the transcript **head** (init mode, `listSessions`/`readHeadMetadata`), the in-session **toolbar** reads the transcript **tail** (latest turn, `getSession`/`readTailStatus`), and **enforcement** reads the in-memory session. These three disagree.
5. **Active-session escalation rejected (distinct bug).** Switching a _running_ session to `bypassPermissions` throws `Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions`. `message-sender.ts:236` only sets `allowDangerouslySkipPermissions` when a session **starts** in bypass, so `updateSession`'s live `activeQuery.setPermissionMode(...)` (`session-store.ts:181`) fails, reverts the in-memory mode, and re-throws → the route returns **422** while the client's optimistic UI still shows bypass. See ADR-0261.

Net effect for all five settings:

| Setting          | Persisted? | Restored on cold start? | Reverts on restart/eviction? | Notes                                                             |
| ---------------- | ---------- | ----------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `permissionMode` | ❌         | hardcoded `'default'`   | **Yes** — the reported bug   | 3-way display/enforcement desync                                  |
| `model`          | ❌         | no (in-memory)          | **Yes**, but _masked_        | SDK `resume` re-reads model from transcript → looks fine, fragile |
| `effort`         | ❌         | no                      | **Yes**                      | not in transcript, no display recovery                            |
| `fastMode`       | ❌         | no                      | **Yes**                      | silent reset                                                      |
| `autoMode`       | ❌         | no                      | **Yes**                      | silent reset                                                      |

This is **structural, not Claude-Code-specific**: any runtime with an in-memory working set + idle eviction inherits it.

## Goals

- Persist all five per-session settings so they survive idle eviction and server restart.
- Make the persisted store the single source of truth for both **enforcement** and **display**, eliminating the badge/toolbar/runtime 3-way desync.
- Keep the fix at the **runtime-agnostic API core layer** so new runtimes inherit durable settings by accepting one injected port; the frontend is unchanged.
- Collapse the five settings (currently duplicated across four declarations) into a single `SessionSettings` type.
- Remove the Claude-specific hardcoded `'default'`; let each runtime declare its own default permission mode.
- Allow **instant** permission-mode switching on active sessions (including → bypass) with no 422/revert, by always launching with `allowDangerouslySkipPermissions` (verified inert in non-bypass modes — ADR-0261).

## Non-Goals

- **No client/transport changes.** The `sendMessage` request body does not gain settings; the server remains authoritative.
- **No new permission modes** or changes to how modes pass through to the SDK (ADR-0240) or how runtimes declare supported modes (ADR-0241).
- **No migration of session _content_** — transcripts (JSONL) remain the runtime-owned source for messages; only operational settings move to the DB (consistent with ADR-0255).
- **No persistence of transient per-send overrides** (e.g. a Tasks-scheduled run forcing `bypassPermissions` for one message). Only user-driven `updateSession` changes are written through.
- **No backfill** of historical sessions; legacy rows simply read as "runtime default" until first changed.

## Technical Dependencies

- `drizzle-orm` (better-sqlite3) — existing `@dorkos/db` package; migrations auto-applied at boot via `migrate()` in `packages/db/src/index.ts`. Generate with `pnpm --filter @dorkos/db db:generate`; `db:check` is the CI gate that fails if generated SQL is uncommitted.
- `zod` — existing schema layer in `@dorkos/shared`.
- No new external dependencies.

## Detailed Design

### Architecture: core owns persistence, runtimes execute

```
                 ┌─────────────────────────── API core (runtime-agnostic) ───────────────────────────┐
   HTTP PATCH ──▶ │  routes/sessions.ts ──▶ runtime.updateSession()                                    │
   HTTP GET   ──▶ │  routes/sessions.ts ──▶ runtime.getSession()/listSessions() ──▶ overlay settings  │
                 │                                                                                      │
                 │  RuntimeRegistry  (owns session_metadata + DB)  ── implements ──▶ SessionSettingsPort│
                 └───────────────────────────────▲──────────────────────────────────────┬─────────────┘
                                  setSessionSettings(port)                     getSessionSettings / saveSessionSettings
                                                  │                                       │
   send (HTTP / Tasks / relay) ─────────────────┐ │                                       ▼
                 ┌──────────────── claude-code runtime (executor) ──────────────────────────────────┐
                 │  SessionStore.ensureForMessage()  ── hydrate ◀── port.getSessionSettings()        │
                 │  SessionStore.updateSession()     ── write-through ──▶ port.saveSessionSettings()  │
                 │  in-memory AgentSession = warm cache (live query.setPermissionMode, per-turn read) │
                 └──────────────────────────────────────────────────────────────────────────────────┘
```

**Source-of-truth model:** persisted store = truth; in-memory `AgentSession` = warm cache; SDK transcript = legacy fallback only.

**Why hydration lives in the runtime (not the route):** internal callers — the Tasks scheduler and relay bindings — call `runtime.sendMessage` directly, bypassing HTTP routes. `ensureForMessage` is the single funnel all send paths share, so hydrating there covers every caller. **Why display overlay lives in the route:** display is HTTP-only; the route already imports `runtimeRegistry`, so overlaying there avoids widening the narrow port with batch-read methods.

### Data model — extend `session_metadata` (ADR-0255 table)

`packages/db/src/schema/sessions.ts`:

```ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const sessionMetadata = sqliteTable('session_metadata', {
  // --- Immutable identity (first-write-wins; ADR-0255) ---
  sessionId: text('session_id').primaryKey(),
  runtime: text('runtime').notNull(),
  agentPath: text('agent_path'),
  createdAt: text('created_at').notNull(),
  // --- Mutable per-session settings (last-write-wins; ADR-0260) ---
  // NULL = "no explicit preference; use the runtime's default."
  permissionMode: text('permission_mode'),
  model: text('model'),
  effort: text('effort'),
  fastMode: integer('fast_mode', { mode: 'boolean' }),
  autoMode: integer('auto_mode', { mode: 'boolean' }),
});
```

All five columns are **nullable** → the migration (`0015_*.sql`, `ALTER TABLE ADD COLUMN`) is backward compatible; existing rows get `NULL` = runtime default; no backfill.

### Shared contract — one `SessionSettings` type + a narrow port

`packages/shared/src/schemas.ts` — collapse the five fields (currently re-listed in `UpdateSessionRequestSchema`, `updateSession` signature, `MessageOpts`, and `ensureSession` opts) into one schema:

```ts
export const SessionSettingsSchema = z.object({
  permissionMode: PermissionModeSchema.optional(),
  model: z.string().optional(),
  effort: EffortLevelSchema.optional(),
  fastMode: z.boolean().optional(),
  autoMode: z.boolean().optional(),
});
export type SessionSettings = z.infer<typeof SessionSettingsSchema>;

// Refactor the existing request schema to reuse it:
export const UpdateSessionRequestSchema = SessionSettingsSchema.extend({
  title: z.string().min(1).max(200).optional(),
});
```

`packages/shared/src/agent-runtime.ts` — narrow port + optional setter, mirroring `AgentRegistryPort`/`RelayPort` + `setMeshCore`/`setRelay`:

```ts
/**
 * Narrow port for durable per-session settings. The API core implements this
 * (over session_metadata) and injects it into runtimes; runtimes never touch
 * the DB directly. Mirrors AgentRegistryPort/RelayPort. See ADR-0260.
 */
export interface SessionSettingsPort {
  getSessionSettings(sessionId: string): Promise<SessionSettings | null>;
  saveSessionSettings(sessionId: string, settings: SessionSettings): Promise<void>;
}

// On AgentRuntime:
/** Inject the core session-settings store for durable hydrate/write-through. */
setSessionSettings?(port: SessionSettingsPort): void;
```

And remove the Claude-specific default assumption by adding a runtime-declared default to `RuntimeCapabilities.permissionModes`:

```ts
permissionModes: {
  supported: boolean;
  /** Mode id used when a session has no stored preference (NULL in the store). */
  default: string;
  values: PermissionModeDescriptor[];
};
```

### Core implementation — `RuntimeRegistry` implements the port

`RuntimeRegistry` already owns `session_metadata` and the DB handle, and is the only entity that can satisfy the `runtime NOT NULL` constraint on insert (it can resolve/infer the runtime). It implements the port structurally:

```ts
async getSessionSettings(sessionId: string): Promise<SessionSettings | null> {
  const db = this.requireDb('getSessionSettings');
  const row = db.select({ /* the 5 setting columns */ })
    .from(sessionMetadata).where(eq(sessionMetadata.sessionId, sessionId)).get();
  if (!row) return null;
  return mapNullsToUndefined(row); // NULL column → omitted key
}

async saveSessionSettings(sessionId: string, settings: SessionSettings): Promise<void> {
  const db = this.requireDb('saveSessionSettings');
  const patch = pickDefined(settings); // only keys explicitly provided are written
  if (Object.keys(patch).length === 0) return;
  const runtime = await this.getSessionRuntimeType(sessionId); // infer 'claude-code' if no row
  db.insert(sessionMetadata)
    .values({ sessionId, runtime, createdAt: new Date().toISOString(), ...patch })
    .onConflictDoUpdate({ target: sessionMetadata.sessionId, set: patch }) // identity columns untouched on conflict
    .run();
}

// For the list-route overlay (not part of the narrow port — used directly by routes):
getSessionSettingsMany(ids: string[]): Map<string, SessionSettings> { /* single `WHERE sessionId IN (...)` */ }
```

UPSERT semantics: creates the row (with inferred runtime) if a PATCH arrives before the first message; otherwise updates only the provided setting columns, leaving identity (`runtime`, `agentPath`, `createdAt`) intact.

### Runtime wiring (claude-code) — hydrate + write-through

`SessionStore` gains the injected port and the runtime's default mode (used as the final fallback):

```ts
private settingsPort?: SessionSettingsPort;
private defaultPermissionMode: PermissionMode = 'default';
configureSettings(port: SessionSettingsPort, defaultMode: PermissionMode): void { … }
```

- **Hydrate** — `ensureForMessage` cold path (no in-memory session): read persisted settings once, seed the new session with precedence `per-send override (opts) → persisted → runtime default`:

  ```ts
  const persisted = await this.settingsPort?.getSessionSettings(sessionId);
  this.ensureSession(sessionId, {
    permissionMode: opts?.permissionMode ?? persisted?.permissionMode ?? this.defaultPermissionMode,
    model: opts?.model ?? persisted?.model,
    effort: opts?.effort ?? persisted?.effort,
    fastMode: opts?.fastMode ?? persisted?.fastMode,
    autoMode: opts?.autoMode ?? persisted?.autoMode,
    cwd: opts?.cwd,
    hasStarted: hasTranscript,
  });
  ```

  `SessionOpts` is widened to carry all five (`SessionSettings & { cwd?; hasStarted? }`); `ensureSession` sets all five on the in-memory `AgentSession`.

- **Write-through** — `updateSession` persists the user's choice **first** (`await this.settingsPort?.saveSessionSettings(sessionId, changedSettings)`), so intent is durable regardless of what happens to the live query, then updates the in-memory mode and makes a **best-effort** live `activeQuery.setPermissionMode(...)`. Only user-driven PATCHes reach `updateSession`, so transient per-send overrides are never persisted. The live-apply failure handling is detailed in the next subsection.

Wiring in `index.ts` (composition root), after `runtimeRegistry.setDb(db)` and runtime registration, alongside `claudeRuntime.setMeshCore(meshCore)`:

```ts
claudeRuntime.setSessionSettings(runtimeRegistry); // registry satisfies SessionSettingsPort structurally
```

`claude-code-runtime.setSessionSettings(port)` forwards to `this.sessionStore.configureSettings(port, CLAUDE_CODE_CAPABILITIES.permissionModes.default)`. `TestModeRuntime` leaves the optional setter unimplemented (no behavior change).

### Instant mode switching — always launch with the bypass capability (ADR-0261)

The SDK refuses `query.setPermissionMode('bypassPermissions')` on a running session unless that query was _launched_ with `allowDangerouslySkipPermissions: true`. Today `message-sender.ts` sets that flag only when the session starts in bypass, so escalating an active session to bypass 422s and reverts.

**Change:** in `message-sender.ts`, set the flag **unconditionally** at launch, decoupled from the current mode:

```ts
// Was: only when session.permissionMode === 'bypassPermissions'
sdkOptions.permissionMode = session.permissionMode;
sdkOptions.allowDangerouslySkipPermissions = true; // always — grants the capability to switch live
```

**Why this is safe (empirically verified):** an isolated SDK probe ran `query()` in `default` mode with and without the flag. Both invoked `canUseTool` for `Write` and honored a `deny` (file not written) — **identical behavior**. The flag is a pure capability gate the SDK consults only when `permissionMode === 'bypassPermissions'`; it does not weaken `default`/`acceptEdits`/`plan`/`dontAsk`. This matches the documented evaluation order (Hooks → Deny → Permission mode → Allow → `canUseTool`), where `default` always falls through to `canUseTool`.

**`updateSession` live-apply becomes best-effort:** persist the chosen mode first (above), then attempt the live `setPermissionMode`. With the flag now always present the bypass switch succeeds instantly mid-run. If any live `setPermissionMode` still fails, **do not 422 or revert** — log it and keep the persisted/in-memory mode (it applies on the next turn). The `message-sender.ts:236` mode-conditional flag block and the `session-store.ts:185` `prevMode` revert are removed.

The single launch point is `message-sender.ts:290` (`query(...)`). The warm-up `query()` in `runtime-cache.ts:184` never executes tools and is unaffected. Other runtimes own their own equivalent (the flag is Claude-SDK-specific).

### Display overlay (route layer) — unify the three surfaces

`routes/sessions.ts`:

- `GET /:id`: after `runtime.getSession(...)`, overlay `runtimeRegistry.getSessionSettings(id)` over the transcript-derived values (store wins; transcript = fallback for legacy rows).
- `GET /` (list): after `runtime.listSessions(...)`, overlay `runtimeRegistry.getSessionSettingsMany(ids)` (one query, no N+1).

After this, the list **badge**, the in-session **toolbar**, and **enforcement** all read the same persisted values.

### End-to-end flows

- **Set bypass, then idle 31 min, then send** → PATCH writes `permission_mode='bypassPermissions'`; eviction drops the warm cache; next send hydrates `bypassPermissions` from the store → **no prompt**. (This is the exact reproduced bug, now fixed.)
- **Set bypass before first message** → PATCH UPSERTs the row (runtime inferred) + warm cache; first message hydrates/keeps bypass; persisted for all future turns.
- **Server restart mid-session** → warm cache gone; next send hydrates from the store.
- **Tasks/relay run with a one-off `permissionMode` override** → `opts` wins for that send; nothing persisted; user preference preserved.
- **Switch an actively-running session to bypass** → mode persisted immediately; live `setPermissionMode('bypassPermissions')` now succeeds (query launched with the flag) → bypass takes effect **for the rest of the current turn**. No 422, no revert. (Previously: 422 + revert; bypass only applied next turn.)

## User Experience

No new UI. The permission-mode dropdown, model picker, effort, fast/auto toggles, and the "Permissions bypassed" badge behave exactly as before — except they now **stay** what the user set them to across idle periods and restarts, and the badge/toolbar always agree with what the agent actually enforces. The honest-by-design principle is upheld: what the UI shows is what the runtime does.

## Testing Strategy

Unit and integration tests (Vitest, `vi.mock`), each with a purpose comment:

- **`RuntimeRegistry` settings store** (`runtime-registry.test.ts`): `saveSessionSettings` UPSERT creates a row with inferred runtime when none exists; updates only provided columns and leaves `runtime`/`agentPath` intact on conflict; `getSessionSettings` maps `NULL`→omitted; round-trips booleans correctly; `getSessionSettingsMany` batch read.
- **Hydration** (`session-store` / `claude-code-runtime` tests): cold `ensureForMessage` with a persisted bypass row → in-memory session is `bypassPermissions` (regression test for the reported bug); precedence `opts override > persisted > runtime default`; no persisted row → runtime default; all five settings hydrate, not just `permissionMode`.
- **Write-through**: `updateSession` calls `saveSessionSettings` with exactly the changed fields; a per-send `MessageOpts.permissionMode` override does **not** trigger a write.
- **Display overlay** (`sessions` route tests): `GET /:id` and `GET /` return store values over transcript-derived ones; legacy session with no row falls back to transcript without error.
- **Cross-runtime**: a runtime that does not implement `setSessionSettings` still functions (port optional); a stored mode not in the resolved runtime's capability `values` falls back to that runtime's `default`.
- **Flag inertness (regression guard for ADR-0261)**: with `allowDangerouslySkipPermissions: true` always set, `default` mode still routes to `canUseTool` and a `deny` still blocks the tool (assert the message-sender sets the flag unconditionally; assert `canUseTool` gating is unchanged). This guards against a future SDK version making the flag non-inert.
- **Instant live switch**: switching an active session to bypass persists the mode and does **not** 422 or revert; a failed live `setPermissionMode` is swallowed (mode still persisted for the next turn).
- **Migration**: `pnpm --filter @dorkos/db db:check` passes (generated SQL committed); fresh-DB boot creates the columns; existing-DB boot applies the `ALTER`s without data loss.

Manual verification: reproduce the original bug (set bypass → wait past eviction or restart the dev server → send a write) and confirm no approval prompt, using the testing agent.

## Performance Considerations

- One extra indexed read on cold-session hydration (primary-key lookup) and one indexed UPSERT per user settings change — both negligible. Warm sessions add zero reads (hydration only runs when the in-memory session is absent).
- List overlay is a single `WHERE sessionId IN (...)` (no N+1).

## Security Considerations

- No new external surface; settings are local SQLite operational metadata. `permissionMode` is validated by `PermissionModeSchema` at the API boundary (ADR-0240) and re-validated against the resolved runtime's capability `values` on read, so a stale/foreign stored mode can never escalate — it falls back to the runtime default. Persisting `bypassPermissions` is intended user state, not a new capability.
- **Always-on `allowDangerouslySkipPermissions` (ADR-0261):** every Claude Code session is launched with the capability to skip permissions, but the **effective gate stays `permissionMode`** — verified inert in non-bypass modes. The skip only happens when DorkOS sets `permissionMode: 'bypassPermissions'` (user-initiated in the UI, or a binding/Tasks config). `setPermissionMode` is a host control request, not a tool, so no prompt or tool call can self-escalate (no prompt-injection path). We intentionally trade the SDK's launch-time guardrail for DorkOS owning the gate; the flag-inertness regression test guards the assumption.

## Documentation

- TSDoc on `SessionSettingsPort`, the new `RuntimeRegistry` methods, and the schema column groups (immutable identity vs mutable settings).
- Update `contributing/architecture.md` (or the runtime/session guide) with the "core owns session-settings persistence via a narrow port" pattern for future runtime authors.
- ADR-0260 and ADR-0261 record the decisions; flip both `proposed → accepted` once implemented and verified (via `/adr:review`).

## Implementation Phases

Ordered task list (single phase; each step independently verifiable):

1. **DB schema + migration** — add the five nullable columns to `packages/db/src/schema/sessions.ts`; run `pnpm --filter @dorkos/db db:generate`; commit `0015_*.sql`; verify `db:check`.
2. **Shared contract** — add `SessionSettingsSchema`/`SessionSettings`; refactor `UpdateSessionRequestSchema` to reuse it; add `SessionSettingsPort` + optional `AgentRuntime.setSessionSettings`; add `permissionModes.default` to `RuntimeCapabilities`; set `default: 'default'` in `CLAUDE_CODE_CAPABILITIES` and the test-mode capabilities.
3. **Core store** — implement `getSessionSettings`/`saveSessionSettings` (+ `getSessionSettingsMany`) on `RuntimeRegistry`; unit tests.
4. **Runtime hydrate/write-through** — widen `SessionOpts`/`MessageOpts`; `SessionStore.configureSettings`; hydrate in `ensureForMessage`; write-through in `updateSession`; seed all five in `ensureSession`; `claude-code-runtime.setSessionSettings` forwarding; wire in `index.ts`.
5. **Always-on bypass capability (ADR-0261)** — in `message-sender.ts`, set `allowDangerouslySkipPermissions: true` unconditionally and drop the mode-conditional block; make `updateSession`'s live `setPermissionMode` best-effort (persist first, no 422/revert, remove the `prevMode` revert).
6. **Display overlay** — overlay persisted settings in `GET /:id` and `GET /` route handlers.
7. **Tests + manual repro** — the suite above (incl. flag-inertness regression and instant-live-switch); reproduce both bugs and confirm fixed.
8. **Docs + ADRs** — TSDoc, contributing guide note, flip ADR-0260 **and** ADR-0261 `proposed → accepted`.

## Open Questions

- **`model` validation on hydrate:** persisted `model` is passed through opaquely (the SDK rejects unknown ids). Validate against `getSupportedModels()` on read, or leave as pass-through? _Lean: pass-through_ (model lists change; over-validation risks dropping valid future models).
- **`SessionStore` default mode injection:** inject the runtime default via `configureSettings(port, default)` (chosen) vs. having `ensureForMessage` call back into capabilities. Chosen approach keeps `SessionStore` free of a capabilities dependency.

_Resolved during research:_ whether an active session can switch to bypass — **yes if launched with `allowDangerouslySkipPermissions`**, which we now always set (ADR-0261, verified inert in non-bypass modes via SDK probe).

## Related ADRs

- **ADR-0260** — Persist Per-Session Settings in the API Core via a Narrow Port (this spec implements it).
- **ADR-0261** — Always Launch Sessions with `allowDangerouslySkipPermissions` for Instant Mode Switching (this spec implements it; companion to 0260).
- **ADR-0255** — Per-Session Runtime Ownership in `session_metadata` (extended: same table).
- **ADR-0240** — Passthrough Permission Modes to SDK (preserved: `session.permissionMode` is now reliably populated before passthrough).
- **ADR-0241** — Runtime Self-Declares Supported Permission Modes (extended: add a declared default).
- **ADR-0256** — Runtime Capabilities Shape (the `permissionModes` structured field gains `default`).
- **ADR-0085** — AgentRuntime Interface as Universal Abstraction (the port + optional setter follow this contract).

## References

- `apps/server/src/services/core/runtime-registry.ts` — table owner; implements the port.
- `apps/server/src/services/runtimes/claude-code/sessions/session-store.ts` — `ensureForMessage`/`updateSession`/`ensureSession`/`checkSessionHealth`.
- `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts` — reads settings from the (now-hydrated) in-memory session.
- `apps/server/src/services/runtimes/claude-code/sessions/transcript-reader.ts` — legacy fallback source for display.
- `apps/server/src/routes/sessions.ts` — PATCH write path, GET display overlay.
- `packages/db/src/schema/sessions.ts`, `packages/db/src/index.ts` — schema + boot migration.
- `packages/shared/src/schemas.ts`, `packages/shared/src/agent-runtime.ts` — contract.
- `apps/server/src/index.ts` — composition root wiring.
