# Desktop renderer supervision — the window that can never stay black

**Spec id:** 260823-163732 · **Tracker:** DOR-1453 · **Project:** Desktop Resilience
**Plan:** `plans/desktop-resilience-program.md` §4 Workstream 1 (items 1.1–1.3 + 0.3)
**Research:** the Electron black-screen research summarized in the plan §2.

## Problem

The desktop shell supervises its server child with a full state machine
(`server-process.ts`) but does nothing for the renderer: `window-manager.ts` handles
neither `did-fail-load`, `render-process-gone`, `child-process-gone`, nor
`unresponsive`, and `revealWhenReady`'s 4s fallback shows whatever is there — including
a permanently black window (the v0.63.0 incident, DOR-1448). Nothing retries, nothing
logs, nothing recovers.

## Decisions

1. **A new `renderer-supervisor.ts` in `apps/desktop/src/main/` owns renderer health.**
   One module, mirroring the server supervisor's "everything about liveness in one
   place" doctrine. `window-manager.ts` stays about window creation/link policy; the
   supervisor attaches to a created window.
2. **Health = a heartbeat, not an event absence.** The renderer reports
   `renderer-alive` over a preload bridge (`window.electronAPI.reportAlive()`, wired in
   `apps/client` after React mounts — call it from `main.tsx` right after
   `ReactDOM.createRoot(...).render(...)` is issued, in a `queueMicrotask`/effect so it
   reflects a real mount). The supervisor arms a **10s deadline** at every
   `loadURL`/reload; a heartbeat clears it.
3. **Failure signals** (any one triggers recovery): heartbeat deadline expiry;
   `did-fail-load` (main frame only, ignore `ERR_ABORTED` -3); `render-process-gone`
   (any reason except `clean-exit`); `unresponsive`; `child-process-gone` with
   `type: 'GPU'` or a `NetworkService` utility crash (these two log + count but only
   trigger the ladder if a heartbeat deadline also expires — a GPU respawn that
   recovers on its own must not reload a healthy app).
4. **Recovery ladder, escalating on a persisted counter.** Counter lives in
   `<userData>/renderer-health.json` (`{ consecutiveFailures, lastFailureAt,
updatedAt }`), read at app start, reset to 0 on any successful heartbeat.
   - N=1: `webContents.reload()`.
   - N=2: `session.defaultSession.clearCache()` then reload.
   - N=3: clear GPU/code caches (`GPUCache`, `Code Cache`, `DawnGraphiteCache`,
     `DawnWebGPUCache` under userData), then `app.relaunch()` + quit **with the flag
     file** telling the next launch to `app.disableHardwareAcceleration()` before
     `ready` (read the same `renderer-health.json`; `disableHardwareAcceleration` must
     run before `app.whenReady()`, so this file is read at the top of `main/index.ts`).
   - N≥4: give up healing; load the **fallback page**.
     Every rung logs one info line to electron-log with the rung and reason.
5. **The fallback page is a bundled static file** (`apps/desktop/src/main/fallback/
fallback.html`, emitted beside the compiled main process the same way tray images
   are — see `emitTrayImages` in `electron.vite.config.ts`). Loaded with `loadFile`.
   Inline CSS only, dark-mode aware via `prefers-color-scheme`, DorkOS wordmark as
   inline SVG, calm copy ("DorkOS is having trouble showing its screen"), three
   actions wired over the existing preload bridge pattern: **Try Again** (reset
   counter to 0, reload the real URL), **Reset and Relaunch** (full cache +
   `Local Storage` wipe, relaunch), **Save Diagnostic Report** (invoke the DOR-1456
   IPC when it exists; until then, `shell.showItemInFolder` on the log directory —
   leave a seam, not a TODO).
6. **The packaged smoke test asserts a real render** (plan 0.3): `smoke-packaged.ts`
   gains an assertion that the heartbeat IPC fired within the deadline (expose a
   test-only signal: the supervisor writes `renderer-health.json` with
   `consecutiveFailures: 0` + fresh `updatedAt` on heartbeat; the smoke asserts that
   file shows a heartbeat newer than launch). This is the gate that catches the whole
   "packages green, black on install" class.
7. **Scope guard:** primary window only (same scoping as update card / deep links).
   A `window.open` secondary cockpit gets crash _logging_ but no ladder — recovering
   the primary is what matters, and two supervisors fighting over shared caches is
   worse than one.

## Non-goals

Automatic GPU-disable persistence beyond one relaunch cycle (the flag clears on a healthy
heartbeat); Windows-specific `integrity-failure` handling; supervising the Obsidian
embed (no Electron shell there).

## Verification bar (fault injection, packaged where possible)

- Unit: ladder transitions (counter file in a temp dir; fake timers).
- Integration (dev Electron run): kill the renderer (`webContents.forcefullyCrashRenderer()`)
  → assert rung 1 reload + heartbeat reset; block the heartbeat (env flag that skips
  `reportAlive`) → assert escalation through rung 4 to the fallback page.
- Packaged smoke: heartbeat assertion (decision 6) green on a good build; a build with
  a deliberately broken renderer (strip the define in a scratch build) must go red.
