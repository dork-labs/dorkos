---
slug: electron-desktop-app
number: 181
created: 2026-03-24
status: ideation
---

# Electron Desktop App

**Slug:** electron-desktop-app
**Author:** Claude Code
**Date:** 2026-03-24
**Branch:** preflight/electron-desktop-app

---

## 1) Intent & Assumptions

- **Task brief:** Create an Electron desktop app as a third distribution method for DorkOS, alongside the existing CLI (browser) and Obsidian plugin. All three share the same codebase — the Transport abstraction makes this possible with minimal new code.
- **Assumptions:**
  - macOS is the primary target (Kai's platform); Windows/Linux come later
  - Direct download (signed DMG) + Homebrew Cask, not Mac App Store
  - The existing `HttpTransport` is sufficient for v1 — no custom IPC transport needed
  - The full router experience (dashboard, agents, sessions) is appropriate for a desktop app
  - Auto-updates are expected for a desktop app
  - The app shares `~/.dork/` data directory with CLI — same agents, same sessions
- **Out of scope:**
  - Mac App Store distribution (sandbox restrictions block subprocess spawning)
  - Windows/Linux for v1 (follow-up)
  - Custom Electron IPC transport (optimization for later if profiling warrants it)
  - Mobile apps
  - Tray-only mode (no window)

## 2) Pre-reading Log

- `packages/shared/src/transport.ts`: 462-line Transport interface — the key abstraction. Defines all methods for sessions, pulse, relay, mesh, agent discovery. Two implementations exist.
- `apps/client/src/layers/shared/lib/transport/http-transport.ts`: 567-line HTTP adapter. Uses fetch + SSE for streaming. Object.assign() binds domain methods at runtime. ETag caching for messages.
- `apps/client/src/layers/shared/lib/direct-transport.ts`: 482-line in-process adapter for Obsidian. Async generators for streaming, direct service calls. Uses `embedded-mode-stubs.ts` for server-only features.
- `apps/client/src/App.tsx`: 157-line embedded shell — no router, pure component tree. Used by Obsidian. Not what we want for Electron (we want full AppShell).
- `apps/client/src/AppShell.tsx`: 286-line standalone shell with TanStack Router, dynamic sidebar/header cross-fades, onboarding gate. This is the Electron entry point.
- `apps/client/src/main.tsx`: Web entry point — creates QueryClient, HttpTransport('/api'), mounts root. Electron will need a similar entry that points at localhost:{port}.
- `apps/server/src/index.ts`: 472-line server bootstrap. Initializes runtimes, feature subsystems (conditional via env vars), graceful shutdown. Can be imported and started programmatically.
- `apps/server/package.json`: Key native dep: `better-sqlite3` (C++ addon). Also `@anthropic-ai/claude-agent-sdk`, `chokidar`, `@ngrok/ngrok`.
- `apps/obsidian-plugin/vite.config.ts`: CJS output, inlineDynamicImports, node18 target. Externalizes electron, obsidian, node builtins. Custom build plugins for Electron compat.
- `apps/obsidian-plugin/build-plugins/patch-electron-compat.ts`: Patches spawn() AbortSignal handling and setMaxListeners() for Electron compatibility.
- `apps/obsidian-plugin/build-plugins/fix-dirname-polyfill.ts`: Replaces fileURLToPath polyfills with direct \_\_dirname references.
- `apps/obsidian-plugin/build-plugins/safe-requires.ts`: Wraps optional requires in try-catch for bundled code.
- `packages/cli/scripts/build.ts`: 105-line CLI build — 3 steps: (1) Vite client → dist/client, (2) esbuild server → dist/server, (3) esbuild CLI → dist/bin/cli.js + copy drizzle migrations.
- `packages/db/`: Drizzle ORM with better-sqlite3. Migrations in `drizzle/`. Database at `~/.dork/dork.db`.
- `apps/server/src/lib/dork-home.ts`: Single source of truth for data directory. Respects `DORK_HOME` env override.
- `apps/server/src/env.ts`: Zod-validated env vars. Server config at startup.
- `turbo.json`: Strict env mode. globalPassThroughEnv for runtime vars, task-level env for build-time vars.
- `contributing/architecture.md`: Hexagonal architecture guide — Transport pattern, data flows, DI.

## 3) Codebase Map

### Primary Components/Modules

| Path                                                            | Role                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/shared/src/transport.ts`                              | Transport interface contract (462 lines)               |
| `apps/client/src/layers/shared/lib/transport/http-transport.ts` | HTTP adapter — reused unchanged in Electron            |
| `apps/client/src/main.tsx`                                      | Web entry point — template for Electron renderer entry |
| `apps/client/src/AppShell.tsx`                                  | Full router shell — Electron's UI entry point          |
| `apps/server/src/index.ts`                                      | Server bootstrap — spawned in UtilityProcess           |
| `apps/server/src/lib/dork-home.ts`                              | Data directory resolver (`~/.dork/`)                   |
| `packages/db/`                                                  | Drizzle ORM + SQLite + migrations                      |
| `packages/cli/scripts/build.ts`                                 | Reference for bundling server + client                 |
| `apps/obsidian-plugin/build-plugins/`                           | Reusable Electron compat plugins                       |

### Shared Dependencies

- `@dorkos/shared` — types, transport interface, schemas, constants
- `@dorkos/db` — database schema, migrations, createDb()
- `@dorkos/client` — React UI, all FSD layers, components
- `@dorkos/server` — Express app, services, runtimes

### Data Flow (Electron)

```
Electron main process
  → spawns UtilityProcess (server-entry.ts)
    → imports @dorkos/server
    → starts Express on localhost:{free-port}
    → initializes SQLite at ~/.dork/dork.db
  → creates BrowserWindow
    → loads renderer (apps/client via electron-vite)
    → preload exposes port via contextBridge
    → renderer creates HttpTransport(`http://localhost:{port}/api`)
    → full AppShell with TanStack Router
```

### Feature Flags/Config

- `DORKOS_PORT` — overridden by Electron to use a free port
- `DORK_HOME` — defaults to `~/.dork/`, shared with CLI
- `DORKOS_PULSE_ENABLED`, `DORKOS_RELAY_ENABLED`, `DORKOS_MESH_ENABLED` — subsystem toggles, passed to UtilityProcess env

### Potential Blast Radius

- **New files:** `apps/desktop/` (entire new app — ~15-20 files)
- **Modified files:** `turbo.json` (add desktop build task), possibly `pnpm-workspace.yaml`
- **Unchanged:** `apps/client/`, `apps/server/`, `packages/shared/`, `packages/db/` — all reused as-is
- **Tests:** New tests for Electron lifecycle, window management. Existing tests unaffected.

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

Full research report saved to `research/20260324_electron_desktop_app_monorepo.md`.

### Potential Solutions

**1. electron-vite + electron-builder + UtilityProcess (HTTP localhost)**

- Description: Use electron-vite for build tooling (single config for main/preload/renderer), electron-builder for packaging/signing/auto-update, UtilityProcess to spawn Express server on a free port, renderer uses existing HttpTransport unchanged.
- Pros:
  - Zero changes to apps/server or apps/client
  - electron-vite is purpose-built for Vite + Electron (single config drives 3 bundles)
  - UtilityProcess provides crash isolation (server crash doesn't kill UI)
  - electron-builder has mature macOS signing/notarization/auto-update
  - HttpTransport reuse means no new Transport adapter needed
  - Renderer can share Vite config with apps/client (path aliases, Tailwind)
- Cons:
  - localhost HTTP adds ~1ms latency per request (imperceptible for UI)
  - UtilityProcess requires Electron 22+ (not an issue — latest is 33+)
  - electron-vite may need verification with Vite 6 (project uses Vite 6)
- Complexity: Medium
- Maintenance: Low (follows established patterns)

**2. electron-forge + DirectTransport (in-process)**

- Description: Use Electron Forge with Vite plugin, import @dorkos/server directly into main process, use DirectTransport like Obsidian plugin.
- Pros:
  - Lowest latency (no network layer)
  - Proven pattern (Obsidian plugin does this)
- Cons:
  - Forge's Vite plugin is marked experimental (v7.5.0)
  - Server crash takes down the whole Electron app
  - Forge packaging is less mature than electron-builder for macOS
  - Would need to handle embedded-mode-stubs (Pulse/Relay/Mesh limitations)
- Complexity: Medium-High
- Maintenance: Medium (Forge ecosystem is less stable)

**3. Custom ElectronIPCTransport**

- Description: Build a new Transport adapter using Electron IPC (contextBridge + ipcMain). Server runs in main process, renderer communicates via typed IPC channels.
- Pros:
  - Fastest possible (~0.08ms per call)
  - Most "Electron-native" approach
  - No HTTP overhead
- Cons:
  - Requires building entire Transport adapter from scratch (~500+ lines)
  - Every Transport method needs an IPC handler
  - Harder to debug than HTTP (no network tab in DevTools)
  - Server crash takes down main process
- Complexity: High
- Maintenance: High (must stay in sync with Transport interface changes)

### Security Considerations

- Context isolation is mandatory since Electron 12 — renderer has no direct Node.js access
- Preload script must use `contextBridge.exposeInMainWorld` — never expose raw `ipcRenderer`
- Code signing + notarization required for macOS distribution
- Hardened runtime required — needs `com.apple.security.cs.allow-jit` entitlement for V8 JIT
- `better-sqlite3` native binary must be unpacked from ASAR (`asarUnpack` config)

### Performance Considerations

- localhost HTTP latency (~1ms) is imperceptible for UI interactions
- UtilityProcess crash isolation means server issues don't freeze the UI
- better-sqlite3 requires rebuild against Electron's Node headers (`@electron/rebuild`)
- Universal binary (arm64 + x64) requires architecture-specific native module builds

### Recommendation

**Recommended Approach:** electron-vite + electron-builder + UtilityProcess (HTTP localhost)

**Rationale:** This approach requires zero changes to existing code. The Express server runs in an isolated UtilityProcess, the renderer uses the existing HttpTransport, and electron-builder provides the most mature macOS packaging pipeline. The ~1ms HTTP latency overhead is imperceptible. This matches the research agent's primary recommendation and aligns with DorkOS's hexagonal architecture — the Transport abstraction was designed for exactly this kind of pluggability.

**Caveats:**

- Verify electron-vite compatibility with Vite 6 early in development
- macOS code signing requires Apple Developer credentials in CI
- better-sqlite3 needs `@electron/rebuild` and `asarUnpack` configuration

## 6) Decisions

| #   | Decision             | Choice                 | Rationale                                                                                                                                                                     |
| --- | -------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Server communication | HTTP over localhost    | Zero changes to apps/server or apps/client. UtilityProcess provides crash isolation. ~1ms latency is imperceptible. IPC optimization can come later if profiling warrants it. |
| 2   | App mode             | Full router (AppShell) | Desktop app should provide the complete DorkOS experience — dashboard, agents page, session page. Embedded single-panel mode doesn't justify a desktop app.                   |
| 3   | App name             | DorkOS                 | Matches the brand. CLI is already `dorkos`. Consistency across all distribution channels.                                                                                     |
| 4   | V1 scope             | macOS only, signed DMG | Ship fast on the primary target platform. Kai is on macOS. Homebrew Cask for easy install. Windows/Linux follow-up.                                                           |

## 7) Proposed Architecture

### Four Distribution Channels, Same Codebase

| Distribution           | Entry Point                        | Transport                        | Server                  | Build Output           |
| ---------------------- | ---------------------------------- | -------------------------------- | ----------------------- | ---------------------- |
| **CLI** (current)      | `packages/cli/src/cli.ts`          | HttpTransport (localhost:4242)   | Bundled in dist/server/ | npm package (`dorkos`) |
| **Web** (current)      | `apps/client/src/main.tsx`         | HttpTransport (`/api`)           | External server         | Static site (dist/)    |
| **Obsidian** (current) | `apps/obsidian-plugin/src/main.ts` | DirectTransport (in-process)     | Imported + bundled      | Obsidian .zip          |
| **Desktop** (proposed) | `apps/desktop/src/main/index.ts`   | HttpTransport (localhost:{free}) | UtilityProcess          | Signed DMG             |

### New Directory Structure

```
apps/desktop/
├── src/
│   ├── main/
│   │   ├── index.ts              # Electron lifecycle, BrowserWindow, UtilityProcess
│   │   ├── window-manager.ts     # Window create/restore, bounds persistence
│   │   ├── menu.ts               # Native macOS menu bar
│   │   └── auto-updater.ts       # electron-updater integration
│   ├── preload/
│   │   └── index.ts              # contextBridge — exposes server port to renderer
│   └── server-entry.ts           # Thin shim: imports @dorkos/server, starts Express
├── build/
│   ├── entitlements.mac.plist    # macOS entitlements (JIT, network, files)
│   ├── icon.icns                 # macOS app icon
│   └── dmg-background.png        # DMG installer background (optional)
├── electron.vite.config.ts       # 3-in-1: main + preload + renderer configs
├── electron-builder.yml          # Packaging, signing, notarization, auto-update
├── package.json
└── tsconfig.json
```

### Key Implementation Details

**Server lifecycle:**

1. Main process picks a free port
2. Spawns `server-entry.ts` via `utilityProcess.fork()`
3. Passes `DORKOS_PORT={free-port}` and `DORK_HOME=~/.dork/` in env
4. Waits for server to signal "ready" via IPC message
5. Creates BrowserWindow pointing at `http://localhost:{port}`

**Renderer integration:**

- electron-vite renderer config points root at `apps/client/src`
- Preload exposes `window.electronAPI.getServerPort()` via contextBridge
- Renderer creates `HttpTransport(`http://localhost:${port}/api`)`
- Full AppShell with TanStack Router loads — identical to web experience

**Native module handling:**

- `@electron/rebuild` rebuilds better-sqlite3 against Electron's Node headers
- `asarUnpack: ["**/node_modules/better-sqlite3/**"]` in electron-builder config
- Universal binary requires arm64 + x64 native builds

**Auto-updates:**

- electron-updater checks GitHub Releases for `latest-mac.yml`
- Background check on app launch, user-visible notification when update ready
- Code signing required for macOS auto-update verification

**Distribution:**

- Signed + notarized DMG via electron-builder
- App Store Connect API keys in CI (avoids 2FA issues)
- Homebrew Cask formula after first public release
- Entitlements: `com.apple.security.cs.allow-jit`, `network.client`, `network.server`, `files.user-selected.read-write`
