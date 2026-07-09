---
slug: desktop-macos-polish
id: 260709-205811
created: 2026-07-09
status: ideation
tracker: DOR-155
---

# Desktop App — Native macOS Polish & Platform Basics

**Slug:** desktop-macos-polish
**Author:** Claude (flow IDEATE stage)
**Date:** 2026-07-09
**Tracker:** DOR-155 - Desktop app: native macOS polish & platform basics

---

## 1) Intent & Assumptions

- **Task brief:** Bring `apps/desktop` (Electron shell) up to the native polish bar set by the Claude Code, Codex, and Linear desktop apps. Polish + gap-fill, not greenfield: icon, menu, auto-updater, window manager, and signed-DMG packaging already exist.
- **Assumptions:**
  - macOS-only. `window-all-closed`'s darwin guard is effectively constant; Windows/Linux paths are out of scope.
  - The app remains a thin shell (~550 lines of main-process code) around `apps/client`; product features live in the client, not the shell.
  - Code signing is scaffolded but not active in CI (`CSC_IDENTITY_AUTO_DISCOVERY=false` path). Auto-update wiring must be safe to ship unsigned (gate on `app.isPackaged`; updates simply won't apply until signing lands).
  - arm64-only build target stays (no Intel/universal work).
- **Out of scope:**
  - Windows/Linux support, Mac App Store, tray icon, multi-window, login item, dock badge (needs product-event plumbing that doesn't exist yet — deferred with dock bounce).
  - Any renderer/product feature work beyond the minimal IPC needed for Settings navigation and deep-link routing.
  - Activating code signing in CI (separate credential task; DOR-155 ships signing-ready code).

## 2) Current state (audit summary)

Full audit in flow session; key facts with locations:

| Area                               | State                                                                                                                                                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App identity                       | `appId com.dorkos.desktop`, `productName DorkOS`, category set. **No `copyright`**, no `description`/`author` in `package.json`, no protocols, no `extendInfo`; Info.plist is all electron-builder defaults incl. unused camera/mic/bluetooth usage strings |
| Menu (`src/main/menu.ts`)          | Hand-rolled 5-menu template; **no Settings… (Cmd+,)**, **no Check for Updates…**, Help has one link; `mainWindow` param dead; hand-lists items that convenience roles (`appMenu`/`editMenu`/`viewMenu`/`windowMenu`) provide                                |
| Dock                               | `activate` recreate works (`index.ts:56-59`); no dock menu; **no `requestSingleInstanceLock()`** — two app copies can run two servers against one `~/.dork` SQLite store                                                                                    |
| Window state (`window-manager.ts`) | Size/pos/maximized persisted to `userData/window-state.json`, save-on-close only; **no multi-display clamp** — restores off-screen after monitor disconnect; min 800×600                                                                                    |
| About panel                        | Default `role:'about'`; no `app.setAboutPanelOptions()`                                                                                                                                                                                                     |
| Auto-updater (`auto-updater.ts`)   | electron-updater fully implemented, **never called** — call site commented out pending signing; no menu trigger, no up-to-date/checking states                                                                                                              |
| Icon                               | `icon.icns` complete (10 reps incl. Retina); `icon.svg` orphaned (no documented regen path)                                                                                                                                                                 |
| DX                                 | **Only app with no `eslint.config.js`/`lint` script** (TSDoc rule not enforced); **zero tests** for 554 lines of main-process logic                                                                                                                         |

## 3) Benchmark (native-macOS bar)

From Electron docs + reference apps (VS Code, Linear, Slack, Claude/Codex desktop):

- **Menu:** prefer `role:` convenience submenus over hand-rolled items; "Settings…" (post-macOS-13 naming) with `Cmd+,` directly under About; "Check for Updates…" in the app menu below About (VS Code pattern); Help carries docs/GitHub/shortcut links.
- **About:** `app.setAboutPanelOptions({ applicationName, applicationVersion, copyright, credits })` → native NSApplication panel; website link goes in Help, not About.
- **Auto-update:** menu-triggered `checkForUpdates()` must surface "You're up to date" via native dialog; `update-downloaded` → native Restart/Later dialog; production-only (`app.isPackaged`); `electron-log` as `autoUpdater.logger`; signing mandatory for updates to actually apply.
- **Window state:** restore geometry AND clamp to currently-connected displays (`screen.getAllDisplays()`), falling back to centered default; debounced save on resize/move, not just close.
- **Dock:** `app.dock.setMenu()` with a few high-value actions; `activate` show-or-recreate; single-instance lock + `second-instance` focus.
- **Deep links:** `mac.protocols` in electron-builder.yml (build-time) + `app.setAsDefaultProtocolClient` (dev) + `open-url` handler (macOS event); only testable in packaged builds.
- **Identity:** explicit `copyright` → `NSHumanReadableCopyright`; only declare usage strings for features actually used; `appId` is frozen forever.

## 4) Confirmed workstreams

Seven candidates from the brief confirmed, re-cut into four PR-sized chunks (each: isolated worktree → PR → REVIEW.md review):

### Chunk A — Platform correctness & DX foundation

1. `requestSingleInstanceLock()` + `second-instance` restore/focus (data-integrity fix, not polish).
2. Window-state hardening: clamp restored bounds to visible displays, debounced save on resize/move, keep maximize special-case.
3. `eslint.config.js` + `lint` script for `apps/desktop` (matching sibling apps), fix any violations (incl. dead `mainWindow` param in `menu.ts`).
4. Vitest scaffold + tests for window-state load/save/clamp logic and single-instance behavior (mocked `electron`).

### Chunk B — Menu, About, dock

1. Rebuild menu on convenience roles; add **Settings… Cmd+,** (IPC → renderer navigates to settings route), **Check for Updates…** placeholder wired in Chunk C, richer Help (Docs, GitHub issues, dorkos.ai).
2. `app.setAboutPanelOptions()` — name, version, copyright, credits.
3. Dock menu (`app.dock.setMenu`) with show/new-session style actions (scoped to what the client supports via URL today).
4. Tests for menu template shape.

### Chunk C — Auto-update UX

1. Wire `setupAutoUpdater()` gated on `app.isPackaged` (remove the commented-out block); background check on launch.
2. Menu-triggered **Check for Updates…** with full state surfacing: checking / up-to-date dialog / downloading / restart-or-later dialog.
3. `electron-log` as updater logger. Tests for the state machine (mocked electron-updater).

### Chunk D — App identity & deep links

1. `electron-builder.yml`: `copyright`, `mac.protocols` (`dorkos://`); `package.json` `description`/`author`; investigate stripping unused privacy usage strings (only if electron-builder supports overriding defaults cleanly).
2. `open-url` handler + `setAsDefaultProtocolClient` + route-forwarding IPC (`dorkos://` → focus window, navigate client route).
3. Document `icon.svg` → `icon.icns` regeneration path (script or README note).

## 5) Decisions

| #   | Decision            | Choice                                                           | Rationale                                                                                                                          |
| --- | ------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Window-state lib    | Keep hand-rolled, add clamp + debounce                           | Existing code is close; `electron-window-state` adds a dep for ~30 lines of logic; repo prefers owning small logic                 |
| 2   | Menu construction   | Convenience roles + custom items                                 | Electron's own guidance; less code, better native behavior                                                                         |
| 3   | Updater shipping    | Wire now, gate on `app.isPackaged`                               | Code-signing CI is a separate credential task; wiring is inert-but-ready and removes dead code                                     |
| 4   | Settings surface    | Reuse client Settings page via IPC navigation                    | Shell stays thin; no native preferences window                                                                                     |
| 5   | Deep-link scope     | Register + focus + navigate only                                 | Sufficient for `dorkos://` links from docs/site; richer routing is product work                                                    |
| 6   | Dock badge / bounce | Deferred                                                         | Needs agent-event plumbing from server → shell that doesn't exist; separate capture                                                |
| 7   | Execution           | 4 sequential PR chunks, subagent-implemented, REVIEW.md-reviewed | Chunks touch overlapping files (`index.ts`, `menu.ts`); sequential avoids conflicts; matches flow config `concurrency: sequential` |

## 6) Risks

- Deep links are only QA-able in a packaged build; test with `pnpm --filter @dorkos/desktop build` + ad-hoc package rather than `electron .`.
- Electron main-process code has no existing test harness in this repo — Chunk A establishes the pattern (vitest + mocked `electron` module) that B–D follow.
- `extendInfo` merges rather than strips; removing default privacy strings may not be cleanly possible — treat as investigate-then-decide inside Chunk D, not a commitment.

## 7) Next stage

SPECIFY — freeze scope into `02-specification.md` with per-chunk acceptance criteria, then DECOMPOSE into `03-tasks.json` mirrored to Linear as sub-issues of DOR-155.
