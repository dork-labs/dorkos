---
paths: 'apps/desktop/**'
---

# Desktop App Rules

The Electron desktop app (`apps/desktop`) is a thin shell around the same server + React client the CLI cockpit runs. Full reference: `contributing/desktop-app-development.md`. The load-bearing facts:

## Packaging model

- The main process spawns the Express server as a child (UtilityProcess in prod, `child_process.fork` via tsx in dev). The server bundle is built by `scripts/build-server.ts` (esbuild) into `dist/server/server-entry.mjs` — **it is NOT produced by `electron-vite build` alone**; the desktop `build` script runs both.
- **`electron-builder.yml`'s `files` is an explicit allowlist** (`package.json`, `dist/**`, `core-extensions/**`). If you make the runtime read a NEW top-level path, add it there or the packaged app won't have it — that failure packages green and only appears once installed. `node_modules` is intentionally absent (electron-builder derives it from the production dependency tree and reads only negative patterns from `files`).
- **Never add `extraResources`** to duplicate something already `asarUnpack`ed. Resolution from `app.asar/dist/server/` reaches `app.asar/node_modules/<pkg>` before it could ever see `resources/node_modules/<pkg>`, so the copy is unreachable — and becomes actively harmful the day the two carry different ABIs. Unpack, don't duplicate.
- In production the window loads `http://localhost:<serverPort>` (the bundled server serves the SPA), **not** `file://` — this avoids the `Origin: null` CORS dead-end. See ADR `260712-005315`.
- Native modules (`better-sqlite3`, `node-pty`) and the Claude Code binary (`@anthropic-ai/claude-agent-sdk-darwin-arm64`) must be `asarUnpack`ed — a Mach-O binary cannot execute from inside `app.asar`.
- Native modules are rebuilt for Electron's ABI at **packaging time only** (`pack`/`dist` scripts + the release workflow), never in plain `pnpm build` — that rebuild poisons the pnpm-store-shared binary for plain-Node vitest across the monorepo (recover with `pnpm rebuild better-sqlite3`).
- `electron-builder`'s own `npmRebuild` is disabled (it produced broken binaries); `scripts/rebuild-natives.ts` calls `@electron/rebuild` directly instead.
- **`build/` is not packaged.** It is electron-builder's `buildResources` — icons and entitlements it reads at _build_ time. Anything the runtime reads must reach `dist/**`: the tray images get there via `electron.vite.config.ts`'s `emitTrayImages()` plugin, which copies them beside the compiled main process so `join(__dirname, name)` resolves the same in dev and packaged.

## Window & app lifecycle

- **Closing the window does not quit** — the server keeps running so agents keep working, on every platform. The guard is `hasTray()`, not `process.platform`: with no tray there is no way back, so the app quits instead. **Never leave the app running with no window and no icon.**
- **`before-quit` has exactly one listener**, in `quit-guard.ts` — every exit funnels through it (Cmd+Q, menu, tray, Dock, `quitAndInstall()`, the crash dialog). It confirms when agents are mid-run, stops the server, then re-issues the quit. **Do not add a second listener that latches on `before-quit`**: a quit can now be cancelled, and a latched flag silently disables whatever it guards for the rest of the session. Ask `isQuitting()`.
- **macOS tray images must keep the `Template` filename suffix** — that suffix is what makes macOS recolour the glyph for light and dark menu bars. Windows uses a **PNG, not the `.ico`**: Electron only decodes `.ico` on Windows, so a `.ico` tray asset cannot be verified anywhere else.
- **Read the renderer origin through an accessor, never a captured value.** A server restart gives a new port, and the link guards in `window-manager.ts` would otherwise hand the app's own pages to the system browser.
- **Only the primary window** persists geometry, receives `dorkos://` deep links and menu navigation, and shows the update card. A second window (`window.open` at our own origin) is a full cockpit without those; two writers on one geometry file would overwrite each other.
- **`Cmd/Ctrl+W` delegates to the renderer**, but only one that subscribed via `onCloseTab`; with no subscriber the window closes immediately, and a subscriber that goes quiet for 3s loses the window anyway. The Window menu says **"Close"**, not "Close Tab", until something in `apps/client` actually subscribes — rename it in the change that ships that, not before. The renderer-facing contract lives on `onCloseTab` in `src/preload/index.ts`; keep it accurate, its consumer is written elsewhere.
- **`quitAndInstall()` closes every window BEFORE calling `app.quit()`**, so `window-all-closed` fires on the update path and `isQuitting()` is still false there. It also **does not always quit** — `MacUpdater` returns with the app alive unless Squirrel has already fetched the update, and `BaseUpdater` skips the quit when `install()` fails. So the update-restart state is a **one-shot token** (`consumeUpdateRestart()`), released on spend, on a `quitAndInstall()` that started no quit, and on any updater `error`. A latch there silently disables the "agents are still working" confirmation for the rest of the session.
- **No flag may skip the `!hasTray()` quit.** Gate the notice, never the quit — a stuck flag must not be able to produce the windowless, tray-less app that everything else here exists to prevent.

## The server build fails on warnings — that is deliberate

`scripts/build-server.ts` fails the build on **any** esbuild warning (`ALLOWED_WARNING_TEXTS` is empty), then `node --check`s the emitted bundle, resolves every runtime specifier from the bundle's own directory, and asserts each one's package is a real `dependencies`/`optionalDependencies` entry (electron-builder packs only the production tree). esbuild reports the silent-breakage cases — unresolvable dynamic `require`, `import.meta` in the wrong format, an unresolved external — as _warnings_, so an unread warning is how a broken bundle ships. If a gate fires, fix the cause; do not widen the allowlist to get green. The gates deliberately stop at resolution and never evaluate the bundle (that would bind a port, touch `~/.dork`, and `dlopen` an Electron-ABI binary under system Node after a `rebuild-natives` run). A failed gate deletes the emitted bundle so it cannot be packaged.

## Verifying a packaged build

`scripts/smoke-packaged.ts` launches the packaged app and asserts it serves `/api/health`, reports the packaged version, and releases its port on quit. It runs the app against a throwaway home — which needs **both** `HOME` _and_ `CFFIXED_USER_HOME`: Electron's `app.getPath('home')` goes through CoreFoundation and ignores `$HOME`, so `HOME` alone leaves the app writing your real `~/.dork`. The script asserts the data directory really landed in the throwaway; keep that assertion. CI runs it in `.github/workflows/desktop-smoke.yml`.

## Runtime-QA gotcha — a "hung" launch is almost always Gatekeeper, not a bug

**Before concluding a packaged/notarized build is broken, rule this out first.** A freshly-downloaded (quarantined) notarized `.app` shows a macOS Gatekeeper consent dialog — _"…downloaded from the Internet. Apple checked it for malicious software…"_ — that **blocks launch until a human clicks Open**. From a terminal (or any headless QA) this is indistinguishable from a hang:

- the process is alive but at **0% CPU**, in `S` (blocked) state,
- **zero** Electron helper processes spawn,
- **nothing** is written to stdout or `~/Library/Logs/@dorkos/desktop/main.log`,
- even `ELECTRON_RUN_AS_NODE=1 <app>/Contents/MacOS/DorkOS -e "console.log(1)"` hangs,
- `sample` shows only `_dyld_start` (hardened runtime blocks real stack introspection — this is a sampling artifact, **not** a dyld hang).

This is **not** a code or signing defect (the dialog itself says notarization passed). For automated/CLI launch QA, strip **all** quarantine attributes first:

```bash
xattr -cr /Applications/DorkOS.app   # -dr com.apple.quarantine MISSES com.apple.macl / com.apple.provenance, which re-trigger the dialog
```

A real end user just clicks **Open** once and the app is trusted thereafter. This cost hours of misdiagnosis once (2026-07-12); do not repeat it.

## Signing & releasing

The desktop build rides the **unified `v*` product release** — `.github/workflows/desktop-release.yml` triggers on the `vX.Y.Z` tags `/system:release` creates and **attaches** the signed/notarized `.dmg` + `.zip` + `latest-mac.yml` to that same release. There is no `desktop-v*` tag scheme; `apps/desktop/package.json`'s version is bumped in lockstep by `/system:release`. Because it's a separate workflow run, a desktop build failure never blocks the product release (fail-soft). Signing/notarization is CI-driven, gated on `APPLE_DEVELOPER_CONFIGURED`. Credentials, the `-legacy` p12 quirk, the ~65-min first-notarization delay, and the recovery steps are all in `contributing/desktop-app-development.md` §Signing.
