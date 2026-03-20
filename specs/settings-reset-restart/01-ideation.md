---
slug: settings-reset-restart
number: 82
created: 2026-03-01
status: ideation
---

# Settings Reset & Server Restart

**Slug:** settings-reset-restart
**Author:** Claude Code
**Date:** 2026-03-01
**Branch:** preflight/settings-reset-restart

---

## 1) Intent & Assumptions

- **Task brief:** Add two dangerous-action buttons to the Settings dialog: (1) "Reset All Data" which deletes all DorkOS data (`.dork` directory + browser localStorage) to factory-reset the app; (2) "Restart Server" to trigger a server restart from the client. Both need multi-step confirmation UX to prevent accidental use.
- **Assumptions:**
  - The `.dork` directory location is resolved by `resolveDorkHome()` and varies: `DORK_HOME` env var > `.temp/.dork` (dev) > `~/.dork` (prod)
  - All services that write to `.dork` re-create their files lazily on startup (config, DB, relay, pulse presets, logs)
  - Reset implies server restart since all in-memory state becomes stale after deletion
  - The server is a local-only tool by default — no additional auth needed beyond CORS + rate limiting
- **Out of scope:**
  - Deleting Claude SDK transcript files (`~/.claude/projects/`)
  - Selective reset (e.g., "only clear Pulse data")
  - External process manager integration (pm2, systemd)

## 2) Pre-reading Log

- `apps/server/src/index.ts`: Full startup sequence (11 services initialized in order) and `shutdown()` function with ordered teardown. This is the template for reset teardown.
- `apps/server/src/lib/dork-home.ts`: Simple 21-line module — resolves `DORK_HOME` env var > `.temp/.dork` (dev) > `~/.dork` (prod). Sets `process.env.DORK_HOME` once at startup.
- `apps/server/src/services/core/config-manager.ts`: Uses `conf` library. Handles missing/corrupt config gracefully — creates fresh file with defaults on construction.
- `apps/server/src/routes/config.ts`: Existing GET/PATCH `/api/config`. Pattern for how routes access services.
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`: Tabbed dialog (Appearance, Preferences, Status Bar, Server). Uses Zustand for UI state, TanStack Query for server config.
- `apps/client/src/layers/features/settings/ui/ServerTab.tsx`: Read-only config display + tunnel button. Where the danger zone section was initially considered.
- `packages/shared/src/transport.ts`: Transport interface that both HttpTransport and DirectTransport implement. New methods needed here.
- `packages/cli/src/cli.ts`: CLI entry point. Dynamically imports server module. Sets env vars (`DORK_HOME`, `DORKOS_PORT`, etc.) before server start.
- `contributing/configuration.md`: Config system docs — ConfigManager, settings reference, REST API.
- `apps/server/src/services/pulse/pulse-store.ts`: PulseStore uses consolidated Drizzle DB (`dork.db`). Auto-migrates schema.
- `apps/server/src/services/relay/adapter-manager.ts`: Manages adapter lifecycle. Watches `adapters.json` via chokidar. Has `shutdown()` for draining in-flight messages.
- `apps/server/src/services/relay/binding-store.ts`: File-backed store for bindings. Creates empty file if missing.

## 3) Codebase Map

**Primary components/modules:**

- `apps/server/src/index.ts` — Server startup/shutdown orchestration (317 lines)
- `apps/server/src/lib/dork-home.ts` — DORK_HOME resolution (21 lines)
- `apps/server/src/services/core/config-manager.ts` — Config I/O with error recovery (152 lines)
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx` — Settings dialog with tabs (~315 lines)
- `apps/client/src/layers/features/settings/ui/ServerTab.tsx` — Server info display (~150 lines)
- `packages/shared/src/transport.ts` — Transport interface for client-server communication

**Shared dependencies:**

- `@dorkos/db` — Drizzle ORM, `createDb()`, `runMigrations()`
- `@dorkos/relay` — RelayCore, AdapterRegistry, SignalEmitter
- `@dorkos/mesh` — MeshCore
- `better-sqlite3` — SQLite driver (open connections that must be closed before deletion)
- `conf` — Config file library (used by ConfigManager)
- `chokidar` — File watching (adapters, bindings, sessions, transcripts)

**Data flow:**
Client button click → Transport.resetAllData() → POST /api/admin/reset → Server teardown → fs.rm(dorkHome) → process.exit(0) → spawn-and-exit (prod) or nodemon restart (dev) → Client polls /api/health → window.location.reload() + localStorage.clear()

**What lives in `.dork` (DORK_HOME):**

| Path                       | Owner Service          | Re-creation                                                 |
| -------------------------- | ---------------------- | ----------------------------------------------------------- |
| `config.json`              | ConfigManager          | Auto-created with defaults on construction                  |
| `dork.db` (+shm, +wal)     | Drizzle/better-sqlite3 | Auto-created + migrated on `createDb()` + `runMigrations()` |
| `logs/`                    | Logger                 | Auto-created by `initLogger()`                              |
| `relay/adapters.json`      | AdapterManager         | Auto-created by `ensureDefaultAdapterConfig()`              |
| `relay/bindings.json`      | BindingStore           | Auto-created on first save                                  |
| `relay/sessions.json`      | BindingRouter          | Auto-created on first save                                  |
| `relay/access-rules.json`  | RelayCore              | Auto-created on init                                        |
| `relay/subscriptions.json` | RelayCore              | Auto-created on init                                        |
| `relay/mailboxes/`         | RelayCore              | Auto-created per subject                                    |
| `pulse/presets.json`       | PulsePresets           | Auto-created with factory defaults                          |

**Feature flags/config:** Pulse, Relay, and Mesh are feature-flag gated. After reset, all start disabled (defaults) unless env vars re-enable them.

**Potential blast radius:**

- Direct: ~8-10 files to create/modify (new route, transport methods, UI components)
- Indirect: All services recover from missing data on startup — no code changes needed
- Tests: New test files for route, UI components, and transport methods

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

Full research report: `research/20260301_settings_reset_restart.md`

**Potential solutions:**

**For Reset:**

1. **Delete entire `.dork` directory + exit** — Clean slate. Requires ordered service teardown before `fs.rm()` to avoid file lock issues (SQLite handles, chokidar watchers). Reset implies restart since all in-memory state is stale. **Recommended.** Complexity: Medium. Maintenance: Low.
2. **Delete directory contents only** — Same file-lock issues, more complex glob, unnecessary complexity. Not recommended.
3. **Each service clears its own data** — Surgical but fragile. Every new service needs a `reset()` method. Complex orchestration, stale in-memory state still exists. Not recommended.

**For Restart:**

1. **Spawn-and-exit (production) / exit-only (dev)** — In production CLI mode, spawn a new process with `child_process.spawn(process.argv[0], process.argv.slice(1), { detached: true, stdio: 'inherit', env: process.env })` then `process.exit(0)`. In dev mode, `process.exit(0)` alone works (nodemon restarts). **Recommended.** Complexity: Low. Maintenance: Low.
2. **Exit-only everywhere** — Simple but server won't come back in CLI mode without manual user intervention. Worse UX.
3. **Cluster module** — Zero-downtime restart. Massive overkill for a single-user local tool.

**For UX:**

- Industry standard "Danger Zone" pattern (GitHub, Vercel, Supabase, Resend): visually separated section, red border, destructive buttons
- **Reset**: Type-to-confirm pattern (user types "reset" before button enables). Most effective for irreversible actions.
- **Restart**: Two-step click or simple AlertDialog confirmation. Lower stakes since server comes back automatically.
- **Client reconnection**: Show "Restarting..." overlay, poll `/api/health` every 1.5s, `window.location.reload()` on success, timeout after 30s.

**Security considerations:**

- Localhost-only CORS is sufficient — no additional auth needed
- Rate limit both endpoints: 3 requests per 5 minutes via `express-rate-limit`
- Reset body requires `{ confirm: 'reset' }` — server validates before acting
- Respond 200 first, then perform teardown asynchronously via `setImmediate()`

## 6) Decisions

| #   | Decision                                      | Choice                                                | Rationale                                                                                                                                                                |
| --- | --------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Where should danger zone buttons live?        | Separate "Advanced" tab in Settings                   | User preference. Keeps dangerous actions isolated from normal server info. Also allows clearing localStorage (client-side state) which doesn't belong in the Server tab. |
| 2   | Should reset clear Claude SDK transcripts?    | No, only `.dork` directory                            | SDK transcripts aren't "ours" to delete. Less destructive. User can manually delete `~/.claude/` if desired.                                                             |
| 3   | Should reset also clear browser localStorage? | Yes                                                   | User explicitly requested this. localStorage holds Zustand-persisted UI state (theme, font, preferences). Clearing it completes the "factory reset" experience.          |
| 4   | How should restart work in CLI mode?          | Spawn-and-exit pattern                                | Automatic restart without user intervention. Spawns new process inheriting all env vars, then exits. Dev mode uses `process.exit(0)` only (nodemon handles restart).     |
| 5   | Reset confirmation pattern                    | Type-to-confirm ("reset")                             | Industry standard for irreversible data deletion. Forces deliberate action vs. clicking through generic "Are you sure?" dialogs.                                         |
| 6   | Reset implies restart?                        | Yes                                                   | After deleting `.dork`, all in-memory service state (DB connections, config cache, watchers) is stale. Server must restart to re-initialize cleanly.                     |
| 7   | API route namespace                           | `POST /api/admin/reset` and `POST /api/admin/restart` | Groups dangerous admin operations under clear namespace. Factory pattern `createAdminRouter(deps)` matches existing codebase conventions.                                |
