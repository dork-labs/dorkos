---
slug: desktop-macos-polish
id: 260709-205811
created: 2026-07-09
status: specified
tracker: DOR-155
---

# Specification — Desktop App Native macOS Polish & Platform Basics

**Feeds from:** `01-ideation.md`. Scope frozen 2026-07-09.

## Goal

`apps/desktop` behaves like a first-class macOS app — correct platform semantics (single instance, sane window restore), a standard mac menu with Settings/Updates/Help, a real About panel, working auto-update UX (signing-ready), app identity metadata, and `dorkos://` deep links — while staying a thin shell (~main-process only; the only renderer change is a navigation listener).

## Non-goals

Windows/Linux, Mac App Store, tray icon, multi-window, login item, dock badge/bounce, activating code signing in CI, Intel/universal builds, any product feature work in the client beyond the navigation IPC listener.

## Constraints

- Main-process code follows existing module layout (`src/main/*.ts`, one concern per file). TSDoc on all exports.
- Every chunk lands with tests. Electron APIs are mocked in vitest (`vi.mock('electron', …)`); Chunk A establishes the harness (vitest config + electron mock in `apps/desktop`), B–D reuse it.
- No new runtime dependencies except where specified (`electron-log` is already a dependency).
- Sequential delivery A → B → C → D (overlapping files: `index.ts`, `menu.ts`, preload). Each chunk: worktree branch off `origin/main` → PR → REVIEW.md review → merge before the next starts.
- Changelog fragment (`changelog/unreleased/<id>-<slug>.md`) required per user-visible chunk (B, C, D; A if the single-instance fix is user-visible — it is: "the app no longer opens twice").

## Chunk A — Platform correctness & DX foundation

### A1. Single-instance lock

- `app.requestSingleInstanceLock()` at the top of main-process startup, before `app.on('ready')` work. If the lock is denied, `app.quit()` immediately (no server spawn, no window).
- `app.on('second-instance', …)`: restore (if minimized) and focus the existing main window.
- **Accept:** launching a second packaged instance focuses the first instance's window and the second process exits; only one server child process exists.

### A2. Window-state hardening (`window-manager.ts`)

- On load, validate persisted bounds against `screen.getAllDisplays()`: if the window's rectangle does not meaningfully intersect any display's `workArea` (≥ 100px visible in both axes), discard position (center on primary) but keep size clamped to the target display.
- Save state debounced (~500ms) on `resize` and `move`, plus the existing save-on-close. Keep the maximize special-case (persist restored bounds, re-maximize on launch).
- **Accept:** unit tests cover: off-screen restore falls back to centered default; partially-visible restore is kept; maximize round-trip; debounce coalesces rapid resize events into one write.

### A3. ESLint + lint script

- Add `eslint.config.js` and a `"lint"` script to `apps/desktop`, modeled on `apps/server` (Node/main-process flavor, TSDoc rules from `@dorkos/eslint-config`). Fix all violations, including the unused `mainWindow` parameter in `menu.ts` (remove it or use it).
- **Accept:** `pnpm --filter @dorkos/desktop lint` passes; turbo `lint` picks the package up.

### A4. Test harness

- `vitest.config.ts` + `"test"` script for `apps/desktop`; shared `__tests__/electron-mock.ts` (or `vi.mock` factory) faking `app`, `BrowserWindow`, `screen`, `dialog`, `Menu`.
- Tests for A1 (lock denied → quit; second-instance → focus) and A2 as above.
- **Accept:** `pnpm --filter @dorkos/desktop test -- --run` green; wired into turbo `test`.

## Chunk B — Menu, About panel, dock menu

### B1. Menu rebuild (`menu.ts`)

- Top-level structure: app menu (custom, see below), `{ role: 'editMenu' }`, `{ role: 'viewMenu' }`, `{ role: 'windowMenu' }`, Help (custom).
- App menu contents, in order: About DorkOS (`role: 'about'`) · separator · **Check for Updates…** (calls the updater module; disabled when `!app.isPackaged`) · separator · **Settings…** `Cmd+,` (sends navigation IPC, below) · separator · `services` · separator · `hide`/`hideOthers`/`unhide` · separator · `quit`.
- Help menu: "DorkOS Documentation" (existing link), "Report an Issue" (GitHub issues URL), "dorkos.ai" — all `shell.openExternal`.
- **Accept:** unit test snapshot/shape-asserts the template: roles present, Settings accelerator is `Cmd+,`, Check for Updates present and gated, Help has 3 external items.

### B2. Navigation IPC (Settings…)

- Main → renderer channel `navigate` (`webContents.send('navigate', path)`); preload exposes `onNavigate(cb: (path: string) => void): () => void` (returns unsubscribe) on `window.electronAPI`.
- Client (`apps/client`): when `window.electronAPI?.onNavigate` exists, the app shell subscribes once on mount and calls TanStack Router `navigate({ to: path })`. Implementation must verify the client's actual settings route and use it; if no routable settings page exists, open the settings surface the client does have (verify commit `474750ac`) and record the finding in the PR body.
- **Accept:** menu Settings… item sends `navigate` with the settings path; client test (RTL) asserts subscription navigates; unsubscribe on unmount.

### B3. About panel

- `app.setAboutPanelOptions({ applicationName: 'DorkOS', applicationVersion: app.getVersion(), copyright: '© 2026 DorkOS', credits: <one-line, from writing-for-humans> })` during startup.
- **Accept:** unit test asserts options passed; manual: About shows name/version/copyright.

### B4. Dock menu

- `app.dock.setMenu()` with: "Show DorkOS" (show/create window). Keep minimal — no product actions until deep-link routes exist (Chunk D can extend if trivial).
- **Accept:** unit test asserts dock menu set on darwin.

## Chunk C — Auto-update UX

### C1. Wire the updater

- Delete the commented-out call in `index.ts`; call `setupAutoUpdater()` unconditionally-but-internally-gated: everything no-ops when `!app.isPackaged`.
- Background check on launch (`checkForUpdatesAndNotify()`), plus a repeating check every 4 hours (`setInterval`, unref'd).
- `autoUpdater.logger = electron-log`; keep `autoInstallOnAppQuit = true`.

### C2. Menu-triggered check with full state surfacing

- Export `checkForUpdatesInteractive()` consumed by the Chunk B menu item. States surfaced via native `dialog.showMessageBox` on the main window: checking (silent unless it errors) → `update-not-available` → "You're up to date" dialog (only for interactive checks, never background) → `update-available` → download proceeds → `update-downloaded` → "Restart Now / Later" dialog → `quitAndInstall()`.
- Errors during an interactive check show a dialog; background errors only log.
- **Accept:** unit tests (mocked `electron-updater`) cover: interactive up-to-date shows dialog; background up-to-date is silent; downloaded → restart choice calls `quitAndInstall`; unpackaged → all entry points no-op. Menu item disabled when unpackaged (B1 already asserts).

## Chunk D — App identity & deep links

### D1. Identity metadata

- `electron-builder.yml`: add `copyright: © 2026 DorkOS`; `package.json`: add `description` and `author`.
- Investigate stripping unused default privacy usage strings via `extendInfo`; apply only if electron-builder cleanly supports overriding defaults (verify against packaged Info.plist). Otherwise document why not in the PR.

### D2. `dorkos://` deep links

- `electron-builder.yml`: `mac.protocols` → scheme `dorkos`.
- Runtime: `app.setAsDefaultProtocolClient('dorkos')` at startup; `app.on('open-url')` → focus/create window, parse `dorkos://<path>` → send `navigate` IPC with `/<path>` (reuses B2 channel). Malformed/unknown paths → just focus the window.
- **Accept:** unit tests for URL → route parsing (incl. junk input); manual QA note in PR: verified via packaged build (`open dorkos://agents`).

### D3. Icon regeneration path

- Document `icon.svg` → `icon.icns` regeneration (script in `apps/desktop/build/README.md` or package script). No pipeline automation required.

## Test plan

Per-chunk unit tests as specified; `pnpm --filter @dorkos/desktop lint|typecheck|test` green per PR; `pnpm verify` (affected) before each PR. Manual packaged-build QA for deep links (D) and a smoke launch for A (single instance) recorded in PR bodies. No e2e/browser tests (main-process scope).

## Decisions carried from ideation

Hand-rolled window state (no new dep) · convenience menu roles · updater gated on `app.isPackaged` · Settings reuses client page via IPC · deep-link = focus + navigate only · dock badge deferred · sequential PR chunks.
