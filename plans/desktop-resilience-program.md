# Desktop Resilience Program — never a black screen, never a silent failed update

**Status:** proposed (2026-08-23, rev 2 — both root causes now CONFIRMED with user
evidence). Investigation triggered by a real user (Lil) whose DorkOS desktop app shows a
permanent black screen after updating to v0.63.0, and whose auto-updates have quit
without installing for ten days.

**Evidence set:** her server log (`~/.dork/logs/dorkos.log`), her Electron main-process
log (`~/Library/Logs/@dorkos/desktop/main.log`), her updater cache
(`~/Library/Caches/@dorkosdesktop-updater/`), her Squirrel installer state
(`~/Library/Caches/com.dorkos.desktop.ShipIt/ShipItState.plist`), and her Chrome console
at `localhost:4242`.

---

## 1. Root cause A — the black screen (CONFIRMED)

**`Uncaught ReferenceError: __APP_VERSION__ is not defined`** in the shipped production
chunk (`index-qoT1u1Sh.js`), reproduced in a plain Chrome tab at `localhost:4242` — so
this was never an Electron/GPU/machine problem. The served SPA bundle is broken.

Mechanism, verified in the repo:

- `apps/client/vite.config.ts` carries the **only** `define` for `__APP_VERSION__`
  (from the root `package.json` version).
- `apps/desktop/electron.vite.config.ts` builds the **same client source** into
  `dist/renderer` (what the packaged server serves via `CLIENT_DIST_PATH`) — and its
  renderer section has **no `define` block at all**. The bundle ships with the bare
  identifier.
- v0.62.0 had **zero** uses of `__APP_VERSION__` in client source — the drift was a
  latent landmine. PR #1179 (DOR-1373, `createBootCache`) added the first use, at
  **module scope** in `main.tsx:283`, ~170 lines before React's error boundary mounts.
  One evaluation → `ReferenceError` → the module aborts → `#root` never renders →
  permanent black window, zero `/api` traffic.

**Blast radius: every v0.63.0 desktop install** — macOS and the Windows alpha (same
electron-vite renderer build in that installer). Not machine-specific.

Why four safety nets missed it:

1. TypeScript is satisfied by the ambient declaration in `vite-env.d.ts` — only the
   vite `define` makes the identifier real, and only one of the two configs has it.
2. `smoke-packaged.ts` asserts `/api/health`, version, and port release — it never
   loads the SPA.
3. e2e (Playwright) runs against the dev/CLI cockpit build (`apps/client`'s own vite
   config, which has the define) — the broken artifact is never exercised.
4. Dogfood is the CLI cockpit, not the packaged desktop app.

Secondary latent bugs in the same class (from the v0.62→v0.63 diff review; real, keep
as hotfix items): `createBootCache`'s unguarded `localStorage` reads and `new URL()` at
module scope; preload `getServerPort` typed `number` while the supervisor can return
`null` (→ `new URL('http://localhost:null/api')` throws, verified).

## 2. Root cause B — updates that never install (evidence-based)

Her main.log tells a ten-day story:

- Aug 13 → Aug 22: `Update available` climbs 0.59 → 0.60 → 0.61 → 0.62 → 0.63. Each is
  downloaded once, and Squirrel **stages it successfully** (`nativeUpdater.update-downloaded`)
  after nearly every 4-hourly check. Nothing ever installs.
- Aug 22 15:14–15:16: she clicks "Restart to install" repeatedly. Each time the app
  quits and comes back **still the old version** — the active
  `quitAndInstall()` path quits without installing, silently, every time. No updater
  `error` event ever fires; nothing is shown to her.
- Aug 23 09:45: `ShipItState.plist` records an install with
  **`launchAfterInstallation: false`** — the _passive_ install-on-ordinary-quit path
  finally applied 0.63.0. That flag is why the app "never relaunches": the passive path
  installs and deliberately does not reopen the app. She reopened manually at 09:52 —
  straight into root cause A's black screen.
- Her ShipIt directory contains **no ShipIt_stderr/stdout logs at all** — consistent
  with the known class of silent ShipIt failures (electron/electron#8912: Electron
  cannot detect them in-process).

Prime suspect for the active-path failure: the quit-guard's `before-quit`
`preventDefault()` intercepting the **Squirrel-initiated** quit (`quitAndInstall` closes
windows then calls `app.quit()`; we cancel it, stop the server, and re-issue a plain
`app.quit()` — evidence says the native install+relaunch arming does not survive that
on her machine). Must be verified by instrumented repro, but the fix below removes the
interception from that path regardless.

Compounding finds:

- **The card lies.** `foldStatus` (`use-desktop-updater.ts`) keeps showing "Restart to
  install" over any later `error`; there is no next-launch check of "did the update
  actually take" (`lastStatus` is in-memory). Failure is structurally invisible.
- **Every update is a full ~340MB download**: `Cannot download differentially …
.zip.blockmap, status 404` — the release workflow never uploads `.zip.blockmap`.
- **Our error dialogs point at a log folder that doesn't exist**: they say
  `~/Library/Logs/DorkOS`, but electron-log names the folder after package.json `name`
  → the real path is `~/Library/Logs/@dorkos/desktop/`.

The two causes compound into her actual experience: stuck on ~0.58 for ten days because
installs silently fail; the one install that finally landed delivered the fatally broken
0.63.0.

## 3. Design vision — error states as a first-class surface

The bar (Jobs/Ive/Rams, per `meta/website-copy/process.md`): **the app must never show a
black rectangle, and it must never lie.** A user who hits a failure should experience:
the app noticed before they did, it already tried the obvious fixes itself, and what
remains is one calm sentence and one obvious button.

1. **The page defends itself.** A tiny inline boot sentinel in `index.html` — no
   framework, no bundle dependency — that turns "the app never came up" into a readable,
   branded message with one action, on every surface (desktop, CLI cockpit, browser).
   This exact incident would have been a sentence + "Copy error details" instead of a
   black screen.
2. **Self-heal silently first.** The shell retries/repairs (reload → clear caches →
   relaunch) with a persisted failure counter before showing anything.
3. **The fallback surface cannot itself fail.** A bundled static page (`loadFile`,
   inline CSS, zero network).
4. **Truth over reassurance.** If the update didn't take, say exactly that next launch
   and offer the remedy. Never re-offer a restart that just silently failed.
5. **Diagnostics are one click.** "Save Diagnostic Report" bundles everything we asked
   Lil to scavenge by hand. Non-technical users never see `~/Library`.

## 4. Implementation plan

### Workstream 0 — v0.63.1 hotfix (release-blocking, do first)

- 0.1 **Fix the define drift**: one shared source of truth for client build-time
  constants (e.g. `apps/client/vite-define.ts` exporting the define block), imported by
  BOTH `apps/client/vite.config.ts` and `apps/desktop/electron.vite.config.ts`.
- 0.2 **Build gate**: after the desktop renderer build, fail if any declared global
  (`__APP_VERSION__`, any future `__X__` in `vite-env.d.ts`) survives un-substituted in
  `dist/renderer` assets. Same fail-loud philosophy as `build-server.ts`'s gates.
- 0.3 **Packaged smoke must load the SPA**: extend `smoke-packaged.ts` to fetch the
  served bundle and assert it executes/renders (minimum: no bare declared globals in
  the served JS; better: drive the window and assert first paint). This is the gate
  that turns "packages green, black on install" into a red build.
- 0.4 **Module-scope hardening** (the diff-review class): guard `createBootCache`
  construction (try/catch → `null`, matching codebase convention); validate the port in
  `resolveApiBaseUrl`; preload `getServerPort` returns `number | null`.
- 0.5 **Inline boot sentinel** in `index.html`: watchdog + `window.onerror` capture; if
  the app hasn't marked boot-complete in ~10s, paint a minimal branded error surface
  with "Try again" + "Copy error details". Works everywhere the client is served.
- 0.6 Fix the wrong log-path strings (`~/Library/Logs/DorkOS` → real path), or point
  electron-log at the `DorkOS` folder explicitly so the dialogs become true.
- 0.7 **Release + user care**: ship v0.63.1; site/download refreshed; Lil (and any
  desktop user) installs by fresh DMG — her auto-updater cannot be trusted to deliver
  the fix (see B), and 0.63.0's cockpit is down entirely.

### Workstream 1 — Renderer supervision & self-healing (the class fix)

- 1.1 `renderer-supervisor.ts`: handle `did-fail-load`, `render-process-gone`,
  `child-process-gone` (GPU + NetworkService), `unresponsive`; log every event (today:
  all invisible).
- 1.2 First-paint heartbeat: renderer → preload → main once the SPA mounts; ~10s
  deadline armed at `loadURL`. (Also becomes the smoke test's render assertion.)
- 1.3 Recovery ladder with a launch-persisted failure counter: reload →
  `session.clearCache()` + reload → clear GPU/code caches + relaunch → bundled static
  fallback page ("Try Again" / "Reset and Relaunch" / "Save Diagnostic Report").
  Counter resets on a healthy heartbeat.
- 1.4 `Cache-Control: no-store` on `index.html`; long-lived immutable caching on hashed
  assets; version-change HTTP-cache clear before the first `loadURL` of a new version.

### Workstream 2 — Honest, self-verifying updates

- 2.1 **Persist updater intent** before `quitAndInstall()` (`{ offeredVersion,
attemptedAt, attempts }` in userData). Next launch: running version < offered version
  → **the update didn't take**; increment attempts; surface it honestly.
- 2.2 **Fallback to full download**: after 2 failed attempts, the card becomes "The
  update couldn't install itself" + **Download fresh copy** (bypasses Squirrel — the
  one remedy for every known per-machine wedge). Stop re-offering plain restart.
- 2.3 **Stop swallowing errors**: fold `error`-after-`downloaded` into a visible failed
  state with calm copy.
- 2.4 **Fix the active install path**: restructure so the Squirrel-initiated quit is
  never `preventDefault`ed — stop the server _before_ calling `quitAndInstall()` in
  `beginUpdateRestart`, and make the quit-guard pass a `restartArmed` quit straight
  through. Verify by instrumented repro on a packaged build (install actually applies
  - relaunches). This preserves the guard's contract (confirm-before-arm already
    happens in `beginUpdateRestart`).
- 2.5 **Upload `.zip.blockmap`** in `desktop-release.yml` so differential updates work
  (~340MB → a few MB per update).
- 2.6 Updater lifecycle logged at info level end-to-end (click → quit → install →
  relaunch reconstructable from main.log alone).
- 2.7 **Purge stale staged updates on launch**: if `app.getVersion()` is ≥ the version
  in `~/Library/Caches/@dorkosdesktop-updater/pending/` or in Squirrel's staged
  `ShipItState.plist`, delete both. Protects a manual overwrite-install (the support
  remedy for a broken updater) from being silently DOWNGRADED by a leftover staged
  update on the next quit — Lil's machine currently holds exactly this state (staged
  0.63.0 + pending zip surviving the install).
- 2.8 **Detect a manual overwrite while running**: the app stays tray-resident after
  the window closes, so drag-installing a new version leaves the OLD process running —
  and the single-instance lock makes "open the new app" simply focus the old one. The
  user installs the fix and still sees the bug. Fix: on `second-instance` (and on
  window focus), compare the on-disk bundle's `Info.plist` version to the running
  `app.getVersion()`; if disk is newer, relaunch into it (or show "DorkOS X.Y.Z was
  installed — Restart to use it").

### Workstream 3 — One-click diagnostics

- 3.1 "Save Diagnostic Report…" (menu + fallback page + tray): zips main.log, server
  log tail, ShipIt state, updater cache metadata, versions, app path + writability,
  redacted config. Writes to Desktop.
- 3.2 First-client-contact marker: server logs one `info` line on first `index.html`
  serve and first `/api` hit per boot — the blind spot that cost us a day (2xx logs are
  debug-only).

### Workstream 4 — Install & first-run experience (macOS)

Research: `research/20260823_electron-macos-dmg-install-first-run-ux.md`. DMG with
drag-to-Applications is what every best-in-class Mac app ships (Slack, Discord, Chrome,
VS Code, Cursor, Claude Desktop, Arc, Raycast, Linear) — the convention is right; ours
is just unstyled. World-class here = convention + polish + guards, not reinvention.

- 4.1 **Branded DMG**: custom `dmg.background` (DorkOS art with an arrow, 540×380,
  Retina via multi-representation TIFF — `tiffutil -cathidpicheck`), `dmg.contents`
  icon positions (app left, Applications right), `window` size, `iconSize`, custom
  volume icon + volume name. Today the `dmg:` block is `sign` + `artifactName` only —
  users get electron-builder's stock art.
- 4.2 **Wrong-home guard**: on launch, if `!app.isInApplicationsFolder()` (running off
  the mounted DMG, `~/Downloads`, or a translocated path), offer one calm dialog to
  move: `app.moveToApplicationsFolder()` (handles replace + relaunch). This is not
  cosmetic — a read-only/translocated path makes Squirrel.Mac's install physically
  impossible, i.e. it silently produces exactly the ten-day no-update failure. Offer,
  don't force (Figma's silent auto-move misfired; one dialog, remembered choice).
- 4.3 Download-page copy on dorkos.ai: a two-step visual ("drag into Applications,
  then open from Applications") written for a non-technical reader.

Note on the DMG's hidden files: `.background.tiff` (the window's wallpaper) and
`.VolumeIcon.icns` (the mounted disk's icon) are dot-prefixed, so a default Finder
never shows them — they only appear with "show hidden files" toggled (Cmd+Shift+.).
Nothing to fix for end users; 4.1 restyles them anyway (electron-builder's convention
puts the background in a hidden `.background/` folder).

### Workstream 5 — Verification philosophy (applies to all of the above)

Fault injection on the **packaged** app, not mocks: strip the define and assert the
gate goes red; kill the renderer and assert the ladder runs; corrupt `Local Storage/`;
feed a stale updater-intent file and assert the honest card; run a real
staged-update → restart cycle and assert version + relaunch. The incident existed
because every green check exercised a different artifact than the one users run.

## 5. Flow mapping

Enter via `/flow:capture`: one program umbrella + items per workstream. Workstream 0 is
EXECUTE-ready now (worktree + patch release v0.63.1; its items are small and
independently verifiable). Workstreams 1–2 warrant SPECIFY (spec dir each — recovery
ladder semantics and updater state machine deserve written contracts); 3 and 4 are
DECOMPOSE-ready (4.1/4.3 need design assets from the brand side). Post-mortem ADR
candidate: "two vite configs build one client" — either unify or permanently share the
define/build settings (`/adr:create`).
