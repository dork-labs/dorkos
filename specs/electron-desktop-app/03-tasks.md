# Electron Desktop App — Task Breakdown

**Spec:** `specs/electron-desktop-app/02-specification.md`
**Generated:** 2026-03-24
**Mode:** Full decomposition

---

## Phase 1: Foundation (3 tasks — all parallel)

### 1.1 Create apps/desktop package with package.json and tsconfig

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** 1.2, 1.3

Create the `apps/desktop/` workspace package with `package.json` (`@dorkos/desktop`), `tsconfig.json`, and the directory structure (`src/main/`, `src/preload/`, `build/`). Install dependencies including `electron`, `electron-vite`, `electron-builder`, `@electron/rebuild`, and workspace references to `@dorkos/server`, `@dorkos/shared`, `@dorkos/db`, `@dorkos/client`.

### 1.2 Configure electron-vite with main, preload, and renderer targets

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** 1.1, 1.3

Create `electron.vite.config.ts` with three build targets: main process (externalized deps, better-sqlite3 external), preload (externalized deps), and renderer (points root at `../client`, uses React + Tailwind plugins, `@/` alias to `../client/src/`).

### 1.3 Add desktop app tasks to turbo.json

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel:** 1.1, 1.2

Add `ELECTRON_VERSION` to `globalPassThroughEnv`. Add a `dist` task with signing-related env vars (`APPLE_API_KEY`, `CSC_LINK`, `GH_TOKEN`, etc.). The generic `build` and `dev` tasks already cover `electron-vite build` and `electron-vite dev`.

---

## Phase 2: Core (6 tasks — 2.1-2.5 parallel, then 2.6)

### 2.1 Implement server-process.ts for UtilityProcess lifecycle management

**Size:** Large | **Priority:** High | **Dependencies:** 1.1 | **Parallel:** 2.2, 2.3, 2.4, 2.5

Create the server process manager: `getFreePort()` (bind to port 0), `startServer()` (fork UtilityProcess with DORKOS_PORT and DORK_HOME env vars, wait for "ready" message with 15s timeout), `stopServer()` (send shutdown message, 5s force-kill timeout), crash recovery dialog (Restart Server / Quit).

### 2.2 Create server-entry.ts shim for UtilityProcess

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel:** 2.1, 2.3, 2.4, 2.5

Create the thin entry point that imports `@dorkos/server` to trigger initialization, signals `{ type: 'ready' }` to the parent process, and listens for `{ type: 'shutdown' }`. May need to add a root export to the server's `package.json` or use a health-check polling approach.

### 2.3 Implement preload script with contextBridge

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel:** 2.1, 2.2, 2.4, 2.5

Create `src/preload/index.ts` using `contextBridge.exposeInMainWorld('electronAPI', ...)` to expose `getServerPort()`, `getAppVersion()`, and `platform`. Never expose raw `ipcRenderer`.

### 2.4 Implement window-manager.ts with state persistence

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel:** 2.1, 2.2, 2.3, 2.5

Create window manager with `hiddenInset` title bar, traffic light positioning (16, 16), 1200x800 default / 800x600 min size, window state persistence to `~/Library/Application Support/DorkOS/window-state.json`, and dev/prod URL loading.

### 2.5 Implement native macOS menu bar

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel:** 2.1, 2.2, 2.3, 2.4

Create menu with App (about, services, hide, quit), Edit (undo/redo/cut/copy/paste/selectAll), View (reload, devtools, zoom, fullscreen), Window (minimize, zoom, front), Help (DorkOS docs link).

### 2.6 Implement main process index.ts orchestrating app lifecycle

**Size:** Medium | **Priority:** High | **Dependencies:** 2.1, 2.2, 2.3, 2.4, 2.5

Wire everything together: register IPC handlers, start server on `app.ready`, create window, setup menu, handle `window-all-closed` (stay in dock on macOS), `before-quit` (stop server), `activate` (re-create window). Auto-updater commented out pending signing.

---

## Phase 3: Build & Package (2 tasks — parallel)

### 3.1 Create electron-builder config and macOS entitlements

**Size:** Medium | **Priority:** High | **Dependencies:** 2.6 | **Parallel:** 3.2

Create `electron-builder.yml` (DMG universal binary, ASAR with unpacking for better-sqlite3, GitHub Releases publish config, notarization) and `build/entitlements.mac.plist` (JIT, unsigned executable memory, network client/server, file access).

### 3.2 Configure native module rebuilding for better-sqlite3

**Size:** Medium | **Priority:** High | **Dependencies:** 2.6 | **Parallel:** 3.1

Verify `postinstall` script runs `electron-rebuild -f -w better-sqlite3`. Handle monorepo hoisting by potentially using `-m ../server` flag. Ensure ASAR unpacking and extraResources copy the rebuilt binary. Test the packaged app can open SQLite databases.

---

## Phase 4: Polish (3 tasks — all parallel)

### 4.1 Implement auto-updater with electron-updater

**Size:** Small | **Priority:** Medium | **Dependencies:** 2.6 | **Parallel:** 4.2, 4.3

Create `auto-updater.ts` with silent download, install-on-quit, and a "Restart Now / Later" dialog when update is downloaded. Logs via electron-log. Requires code signing to function.

### 4.2 Add Electron detection to client main.tsx and type declarations

**Size:** Small | **Priority:** High | **Dependencies:** 2.3 | **Parallel:** 4.1, 4.3

Add `getApiBaseUrl()` to `apps/client/src/main.tsx` (5-line check for `window.electronAPI`). Add `ElectronAPI` interface and `Window` augmentation to `vite-env.d.ts`. This is the ONLY change to `apps/client/`.

### 4.3 Add app icon placeholder and build directory assets

**Size:** Small | **Priority:** Low | **Dependencies:** 1.1 | **Parallel:** 4.1, 4.2

Create `build/icon.icns` from the existing DorkOS SVG logo. Optionally create `dmg-background.png`. Can use a placeholder initially and refine later.

---

## Summary

| Phase              | Tasks  | Parallel Opportunities        |
| ------------------ | ------ | ----------------------------- |
| 1. Foundation      | 3      | All 3 parallel                |
| 2. Core            | 6      | 5 parallel, then 1 sequential |
| 3. Build & Package | 2      | Both parallel                 |
| 4. Polish          | 3      | All 3 parallel                |
| **Total**          | **14** |                               |

**Critical path:** 1.1 → 2.1-2.5 (parallel) → 2.6 → 3.1/3.2 (parallel)

**Key risk:** The server entry shim (2.2) depends on how `apps/server/src/index.ts` exports its initialization. May need to add a root export to the server's `package.json` or use health-check polling.

**Only change to existing code:** Task 4.2 modifies `apps/client/src/main.tsx` (add `getApiBaseUrl()`) and `apps/client/src/vite-env.d.ts` (add `ElectronAPI` types). Everything else is new code in `apps/desktop/` and a minor `turbo.json` update.
