# Desktop updater overhaul — installs that verify themselves, failures that speak

**Spec id:** 260823-163823 · **Tracker:** DOR-1454 (honesty) + DOR-1455 (install path)
**Project:** Desktop Resilience · **Plan:** `plans/desktop-resilience-program.md` §2B, §4 WS2

## Problem (evidence, real user)

Ten days of updates (0.59→0.63) downloaded and staged, never installed, zero errors
surfaced anywhere. Clicking "Restart to install" quit and relaunched the OLD version
repeatedly. The one install that finally happened rode the passive install-on-quit path
(`ShipItState.plist` `launchAfterInstallation: false` — installs, never relaunches).
Squirrel's ShipIt failures are undetectable in-process (electron/electron#8912), so
detection must move to the next launch. Meanwhile the card (`use-desktop-updater.ts`
`foldStatus`) deliberately keeps "Restart to install" showing over any later `error`,
and `lastStatus` is in-memory — a failed install is structurally invisible.

## Decisions — DOR-1454 (honesty)

1. **Persist install intent** in `<userData>/updater-intent.json`:
   `{ offeredVersion, attemptedAt, attempts }`. Written (attempts incremented)
   inside `beginUpdateRestart()` **before** `quitAndInstall()`; also written by the
   `autoInstallOnAppQuit` path via the quit-guard's shutdown sequence when a
   `downloaded` status is latched (one write helper in `auto-updater.ts`, exported).
2. **Next-launch verdict** (in `setupAutoUpdater`, before the first check):
   read the intent file. `app.getVersion() >= offeredVersion` (semver) → success:
   delete the file. Running < offered → **the install failed**: keep the file, log
   one warn line, and push a new status to the renderer:
   `{ state: 'install-failed', version, attempts }`.
3. **Card states become honest.** Extend the `UpdateStatus` union (and its hand-synced
   `DesktopUpdateStatus` twin in `apps/client/src/vite-env.d.ts`) with
   `install-failed`. `foldStatus`: `error` and `install-failed` arriving over
   `downloaded` REPLACE it (no more swallowing); a later genuine
   `downloading`/`downloaded` for a **newer** version replaces the failure.
4. **Fallback to full download.** When `attempts >= 2` (or on `install-failed`), the
   card's action becomes **Download fresh copy** → `shell.openExternal` to
   `https://dorkos.ai/download/mac` (the remedy that bypasses Squirrel entirely).
   Copy per `writing-for-humans`: "The update couldn't install itself. Download a
   fresh copy — your settings and agents stay put." Plain restart is not re-offered
   past 2 attempts.
5. The sidebar `UpdatePill`/bottom-slot arbitration treats `install-failed` as
   actionable (it qualifies for the slot like `downloaded` does today).

## Decisions — DOR-1455 (install path)

6. **Never intercept the updater's quit.** In `beginUpdateRestart()`: after the
   agent-interruption confirm, `await stopServer()` FIRST, then `armUpdateRestart()`,
   then `quitAndInstall()`. In `quit-guard.ts`, when `consumeUpdateRestart()` is true
   the `before-quit` handler must NOT `preventDefault()` at all — the server is
   already down, so the sequence has nothing left to do; let Squirrel's quit run its
   native course. (Preserve the guard's existing behavior for every other quit; the
   `armed`/`quitting` semantics and the "one before-quit listener" rule stand.)
7. **Purge stale staged updates on launch**: if `app.getVersion() >=` the version
   named in `<Caches>/@dorkosdesktop-updater/pending/update-info.json` (or the
   pending zip's parsed filename), delete the pending dir; also delete
   `<Caches>/com.dorkos.desktop.ShipIt/ShipItState.plist` + staged `update.*` dirs
   under the same condition (downgrade protection after a manual overwrite install).
   Cache dir roots resolved from Electron paths, never hardcoded homedir.
8. **Detect manual overwrite while running**: on `second-instance` and on primary
   window `focus`, read the on-disk bundle's `Info.plist` `CFBundleShortVersionString`
   (path from `app.getPath('exe')` walked up to the bundle; guard non-mac). If disk >
   running: log, then show the native dialog "DorkOS <v> was installed. Restart to
   use it." → `app.relaunch()` + quit through the normal quit sequence. Throttle to
   one prompt per version.
9. **Lifecycle logging**: one info line each — restart clicked, server stopped,
   quitAndInstall called, before-quit-for-update fired, intent written, next-launch
   verdict — so a user's main.log reconstructs the whole story (today `beginUpdateRestart`
   is silent).

## Sequencing

DOR-1454 lands first (intent file + statuses + card). DOR-1455 builds on the intent
helper and the same files (`auto-updater.ts`, `quit-guard.ts`) — one branch each,
sequential, not parallel.

## Verification bar

- Unit: intent write/verdict matrix (fresh install, success, fail ×1, fail ×2,
  downgrade-purge conditions); `foldStatus` truth table incl. the two new states;
  quit-guard pass-through when restart armed (assert no `preventDefault`).
- Integration: simulate next-launch failure (write intent file with a higher
  offeredVersion, boot, assert `install-failed` status pushed + file retained).
- Packaged (manual, once, on a scratch build): a real staged update → restart click →
  assert install applies AND the app relaunches; a fabricated stale pending dir is
  purged on boot. Record results on the tracker items (evidence.attachTo).
