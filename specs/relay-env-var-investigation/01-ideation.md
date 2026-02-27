---
slug: relay-env-var-investigation
number: 66
created: 2026-02-26
status: ideation
---

# Relay Initialization Failure & Feature Flag DX

**Slug:** relay-env-var-investigation
**Author:** Claude Code
**Date:** 2026-02-26
**Branch:** preflight/relay-env-var-investigation
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** `DORKOS_RELAY_ENABLED=true` in `.env` has no effect — the server reports `relay.enabled: false` in the config endpoint. Pulse and Mesh both work correctly with the same env var pattern. Root cause: `RelayCore` is not passed the consolidated Drizzle `db` during server initialization, causing it to attempt creating a standalone SQLite DB in a directory that doesn't exist. The try/catch silently swallows the error, and the feature flag is never set.
- **Assumptions:**
  - The consolidated Drizzle DB (`@dorkos/db`) is the intended database strategy for all subsystems
  - The legacy standalone DB path in `RelayCore` exists only for backward compatibility and tests
  - All three subsystems (Pulse, Relay, Mesh) should follow an identical initialization pattern
  - The dev data directory (`.temp/.dork/`) is created by `createDb()` but subdirectories are not auto-created
- **Out of scope:**
  - Full feature flag system redesign (tracked separately)
  - Removing the legacy DB path from `RelayCore` (needed for tests)
  - Changes to `resolveDorkHome()` logic or dev vs production directory resolution

---

## 2) Pre-reading Log

- `apps/server/src/index.ts`: Server startup — Pulse receives `db` (line 74), Mesh receives `db` (line 132), but Relay does NOT (line 92). This is the root cause.
- `apps/server/src/env.ts`: Zod-based env parsing. `boolFlag` correctly transforms `'true'` → `true`. All three feature flags use identical parsing.
- `apps/server/src/lib/dork-home.ts`: Dev mode resolves to `{cwd}/.temp/.dork/`. Production resolves to `~/.dork/`.
- `packages/relay/src/relay-core.ts:151-175`: Constructor has `if (options?.db)` branch for consolidated DB, else creates standalone at `{dataDir}/index.db`. The standalone path calls `createDb(dbPath)` which throws if directory doesn't exist.
- `packages/relay/src/types.ts:147-160`: `RelayOptions.db` is a supported optional parameter of type `import('@dorkos/db').Db`.
- `apps/server/src/routes/config.ts:99-101`: Config endpoint returns `relay: { enabled: isRelayEnabled() }` — no diagnostic info about why a subsystem might be disabled.
- `apps/server/src/lib/feature-flag.ts:10-24`: Simple closure-based boolean flag. No error state or reason tracking.
- `packages/relay/src/endpoint-registry.ts`, `subscription-registry.ts`: Both read/write JSON files in `dataDir`. They also need the directory to exist.

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/server/src/index.ts` — Server startup orchestration. Lines 84-119 handle Relay init.
- `packages/relay/src/relay-core.ts` — `RelayCore` class with DB injection support via `options.db`.
- `apps/server/src/lib/feature-flag.ts` — `createFeatureFlag()` factory. Boolean-only, no error tracking.
- `apps/server/src/services/relay/relay-state.ts` — Relay feature flag instance.
- `apps/server/src/routes/config.ts` — `/api/config` endpoint that reports feature flag states.

**Shared Dependencies:**

- `@dorkos/db` — `createDb()`, `runMigrations()`, `Db` type. Used by PulseStore, MeshCore, and (should be) RelayCore.
- `apps/server/src/lib/dork-home.ts` — `resolveDorkHome()` for data directory resolution.

**Data Flow:**

```
.env → dotenv-cli → process.env → env.ts (Zod parse) → index.ts (feature enabled?)
  → if enabled: new RelayCore({...}) → try/catch → if success: setRelayEnabled(true)
  → /api/config → isRelayEnabled() → client useRelayEnabled()
```

**Feature Flags/Config:**

- `DORKOS_RELAY_ENABLED` env var → `env.DORKOS_RELAY_ENABLED` (boolean)
- `configManager.get('relay')` → `{ enabled: boolean, dataDir?: string }` (config file fallback)
- `relayEnabled = env || config` (env takes precedence via `||`)

**Potential Blast Radius:**

- Direct: 3 files (`index.ts`, `relay-core.ts`, `config.ts`)
- Indirect: 0 files (the fix aligns with existing patterns, no API changes)
- Tests: `relay-core.test.ts` may need a test for the `db` injection path

---

## 4) Root Cause Analysis

- **Repro steps:**
  1. Set `DORKOS_RELAY_ENABLED=true` in `.env`
  2. Run `pnpm dev`
  3. Visit `http://localhost:{port}/api/config`
  4. Observe `relay.enabled: false`

- **Observed vs Expected:**
  - Observed: `relay.enabled: false`, no relay routes mounted, no error shown in UI
  - Expected: `relay.enabled: true`, relay routes mounted, Relay panel functional

- **Evidence:** Server log output:
  ```
  [DB] Consolidated database ready at .temp/.dork/dork.db
  [Pulse] PulseStore initialized
  ERROR [Relay] Failed to initialize at .temp/.dork/relay
    { error: 'Cannot open database because the directory does not exist' }
  [Mesh] MeshCore initialized (using consolidated DB)
  ```

- **Root-cause hypotheses:**
  1. **Missing `db` injection** (HIGH confidence) — `index.ts:92` creates `new RelayCore({ dataDir, adapterRegistry })` without passing `db`. RelayCore falls to the legacy path (`relay-core.ts:170-174`) which calls `createDb(path.join(dataDir, 'index.db'))`. The relay data directory (`.temp/.dork/relay/`) doesn't exist, so `better-sqlite3` throws "Cannot open database because the directory does not exist." The try/catch at `index.ts:110` swallows the error and sets `relayCore = undefined`. At line 193, `relayEnabled && relayCore` evaluates to `true && undefined` = `false`, so `setRelayEnabled(true)` is never called.
  2. **Missing `mkdirSync`** (MEDIUM confidence) — Even if `db` were passed, other RelayCore sub-modules (`EndpointRegistry`, `SubscriptionRegistry`, `MaildirStore`) also write to the data directory. The directory needs to exist.
  3. **Env var parsing issue** (ELIMINATED) — Verified: `dotenv-cli` loads the value correctly, Zod parses `'true'` → `true`, the server would `process.exit(1)` on parse failure.

- **Decision:** Hypothesis #1 is the primary cause. Hypothesis #2 is a secondary defensive fix.

---

## 5) Research

- **Potential solutions:**

  **1. Pass consolidated `db` to RelayCore (primary fix)**
  - Description: Add `db` to the `RelayCore` constructor call in `index.ts`, matching the pattern used by `MeshCore`
  - Pros: One-line fix, uses the intended architecture, eliminates standalone DB creation in production
  - Cons: None — this is clearly the intended design (the `db` option exists specifically for this)
  - Complexity: Low
  - Maintenance: Low

  **2. Add defensive `mkdirSync` in RelayCore constructor**
  - Description: Before any file operations, ensure `dataDir` exists via `fs.mkdirSync(dataDir, { recursive: true })`
  - Pros: Makes the legacy DB path work, prevents similar failures from other sub-modules
  - Cons: Masks the real issue (missing `db` injection), but good defense-in-depth
  - Complexity: Low
  - Maintenance: Low

  **3. Add diagnostic `initError` to feature flag system and config endpoint**
  - Description: When a subsystem fails to init, capture the error message and expose it in `/api/config` as `relay: { enabled: false, initError: "..." }`
  - Pros: Makes silent failures visible to users and the client UI. World-class DX.
  - Cons: Slightly more code, but the pattern is simple and reusable across all 3 subsystems
  - Complexity: Low-Medium
  - Maintenance: Low

- **Recommendation:** All three. The `db` injection is the fix. The `mkdirSync` is defense-in-depth. The diagnostic field is the DX improvement that prevents users from ever being confused by a silent failure again.

---

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Fix scope | Comprehensive DX fix | User chose: pass `db` to RelayCore + defensive `mkdirSync` + diagnostic `initError` in config endpoint. Prevents this class of bug and improves debuggability. |
| 2 | Diagnostic field location | `/api/config` response body | The config endpoint already reports feature flag state — adding `initError` is a natural extension. Client can conditionally render it in settings or a status indicator. |
| 3 | Legacy DB path | Keep but guard | The standalone DB path in `RelayCore` is used by tests. Add `mkdirSync` guard so it works when directory doesn't exist, but the production path should always use injected `db`. |
