# Desktop App Development Guide

> Developer reference for the DorkOS desktop app (`apps/desktop`) — a thin Electron shell that runs the same Express server and React client as the CLI cockpit, packaged as a signed, notarized macOS app.

---

## 1. What the desktop app is

`apps/desktop` is a **thin shell**. It does not reimplement the product — it starts the same `@dorkos/server` and loads the same `@dorkos/client` SPA that `dorkos` (the npm CLI) runs. Its job is native integration: a real menu bar, a tray presence, supervising the server as a child process that outlives the window, single-instance behavior, window-state restore, `dorkos://` deep links, auto-update, and shipping the whole stack as one installable app.

Build tooling: `electron-vite` (main/preload/renderer) + `electron-builder` (packaging/signing). Renderer root is `apps/client`. The app targets **macOS arm64** today (see `electron-builder.yml` `mac.target`), plus an unsigned Windows x64 alpha.

```
apps/desktop/
├── src/main/            # main process — see the module map below
├── src/preload/         # contextBridge → window.electronAPI
├── src/shared/          # constants main, the build config and the smoke all read
│                        #   (tray-images.ts, boot-timeouts.ts, login-shell-path.ts)
├── src/server-entry.ts  # the server child's entry (imports @dorkos/server for its side effect)
├── build/               # buildResources: icons, entitlements, tray images (see build/README.md)
├── scripts/
│   ├── build-server.ts     # esbuild-bundles server-entry.ts → dist/server/server-entry.mjs
│   ├── rebuild-natives.ts  # @electron/rebuild for better-sqlite3 / node-pty (Electron ABI)
│   └── smoke-packaged.ts   # launches the packaged app and asserts it serves
├── electron-builder.yml # packaging, signing, notarization, files/asarUnpack
└── electron.vite.config.ts
```

### The main-process module map

One job per module. `index.ts` is wiring and ordering **only** — every policy below belongs to the module named for it, and pushing a decision up into `index.ts` is how this directory used to grow.

| Module                        | Job                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                    | The single-instance lock, deep-link registration, the IPC handlers, the ordered `ready` sequence, `window-all-closed`, `activate`. Holds no policy of its own.                                                                                                                                                          |
| `window-manager.ts`           | What a window **is**: web preferences, the `will-navigate` / `setWindowOpenHandler` link policy, and building a second cockpit window.                                                                                                                                                                                  |
| `window-state.ts`             | Where a window **sits**: geometry load/validate/persist (`userData/window-state.json`), plus the display-change rescue. Primary window only — see the scoping table in §5.                                                                                                                                              |
| `menu.ts`                     | The platform-branched application menu, and the macOS Dock menu.                                                                                                                                                                                                                                                        |
| `about.ts`                    | The macOS About panel.                                                                                                                                                                                                                                                                                                  |
| `navigation.ts`               | `dorkos://` parsing, renderer-readiness tracking, and the single pending-navigation slot.                                                                                                                                                                                                                               |
| `tray.ts`                     | The menu-bar / notification-area presence and its activity summary. `hasTray()` is what makes background running safe (§5).                                                                                                                                                                                             |
| `background-notice.ts`        | The one-time "DorkOS is still running" dialog, ledgered in `userData/shell-notices.json`.                                                                                                                                                                                                                               |
| `quit-guard.ts`               | `before-quit` — the single funnel every exit reaches. Owns `isQuitting()`.                                                                                                                                                                                                                                              |
| `renderer-health/`         | Whether the window ever **painted**: the heartbeat deadline, the failure signals, the persisted recovery ladder, and the bundled recovery page it ends on. Primary window only — see the scoping table in §5.                                                                                                           |
| `log-location.ts`          | Where this machine's log file is, for a dialog to point at. Derived from electron-log, never a platform literal.                                                                                                                                                                                                        |
| `close-tab.ts`                | `Cmd/Ctrl+W`'s main-process half: the subscribe / ask / ack protocol with the renderer.                                                                                                                                                                                                                                 |
| `event-stream.ts`             | Owns the **one** connection to the server's `GET /api/events` (connect/reconnect/backoff, frame parsing) — every subscriber (below) gets every frame off it and decides for itself what to do with them. Throw-isolated per subscriber: one subscriber's bug is logged and never stops another, or crashes the process. |
| `agent-activity.ts`           | A subscriber of `event-stream.ts`: counts agents whose `session_status` lifecycle is `streaming`/`blocked`, for the tray.                                                                                                                                                                                               |
| `notifications/index.ts`      | A subscriber of `event-stream.ts`: native OS notifications for Blocking Asks (always) and Notable activity (only while unfocused) — see §5 and ADR `260819-234830`.                                                                                                                                                     |
| `notifications/copy.ts`       | Pure: what a banner says, and where its click routes to. No SSE, no Electron.                                                                                                                                                                                                                                           |
| `notifications/answer.ts`     | Calls the same `POST /api/sessions/:id/{approve,deny,submit-answers}` routes the cockpit's own buttons call, over `127.0.0.1` from the main process, with the 401/403 fallback.                                                                                                                                         |
| `notifications/wrapper.ts`    | The thin seam around Electron's `Notification` — the only file that imports it, so the rest of `notifications/` is testable without a real Electron runtime.                                                                                                                                                            |
| `auto-updater.ts`             | The electron-updater lifecycle, the in-app update card's IPC, and the two update-restart states.                                                                                                                                                                                                                        |
| `updater-intent.ts`           | What the app was promised it was about to install, remembered across the restart that installs it — the only way a Squirrel failure can be detected (§5).                                                                                                                                                               |
| `updater/cache.ts`            | Where Squirrel and electron-updater keep their state on disk, and the launch-time purge of a staged update the running version has already caught up with (§5).                                                                                                                                                         |
| `updater/manual-overwrite.ts` | Noticing that a newer app was installed on disk while this one kept running, and offering the restart that picks it up (§5).                                                                                                                                                                                            |
| `updater/app-bundle.ts`       | Reading the `.app` bundle on disk: where it is, and what version it claims. A leaf; `diagnostics/` and `updater/manual-overwrite.ts` both need it.                                                                                                                                                                      |
| `server-port.ts`              | **Which port** to ask for: the pin-vs-default asymmetry, the upward scan, `PortUnavailableError` (§2).                                                                                                                                                                                                                  |
| `server-cwd.ts`               | **Which directory** the packaged server works in: `server.cwd`, clamped into the boundary and checked to exist (§3.4).                                                                                                                                                                                                  |
| `shell-path.ts`               | **Which PATH** the server child gets: the one-shot login-shell probe that undoes launchd's four-directory PATH (§3.4).                                                                                                                                                                                                  |
| `user-config.ts`              | Reads `config.json` off disk for the two modules above, before the server (and its config manager) exists.                                                                                                                                                                                                              |
| `dork-home.ts`                | Which data directory the child will open, so anything main reads _before_ the server starts (the pinned port in `config.json`) agrees with what the child then writes.                                                                                                                                                  |
| `server-spawn.ts`             | **How** to start a server child (§2).                                                                                                                                                                                                                                                                                   |
| `server-process.ts`           | **Supervises** the child (§2).                                                                                                                                                                                                                                                                                          |
| `server-crash-recovery.ts`    | The conversation with the user after an unexpected death (§2).                                                                                                                                                                                                                                                          |
| `server-output.ts`            | The child's stderr, made safe to show (§2).                                                                                                                                                                                                                                                                             |

## 2. The packaging model (how it actually runs when installed)

This is the part that surprises people. Getting it wrong produces an app that builds fine and even launches under `electron-vite preview`, yet fails only in a real packaged install.

### The server runs as a child process

The main process spawns the Express server, not in-process:

- **Production**: Electron `UtilityProcess.fork` of the bundled `dist/server/server-entry.mjs`.
- **Development**: `child_process.fork` via `tsx` of the original `src/server-entry.ts` (system Node, so the shared `better-sqlite3` stays compiled for system Node and `pnpm dev` keeps working).

Five small modules own this, split by job:

| Module                              | Job                                                                                                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/server-port.ts`           | **Which port** to ask for. See the asymmetry below; port selection left `server-spawn.ts` in DOR-539.                                                                                                          |
| `src/main/server-spawn.ts`          | **How** to start a child: entry resolution, env wiring, the `tsx` shim (`tsx.cmd` on Windows), stdout/stderr into `electron-log`.                                                                              |
| `src/main/server-process.ts`        | **Supervises** the child: readiness handshake (`{type:'ready'}`), one `exit` listener, and an explicit `starting \| ready \| stopping \| dead` state with a single `expectedExit` flag only `stopServer` sets. |
| `src/main/server-crash-recovery.ts` | The **conversation with the user** after an unexpected death: what to say, whether to offer a restart, when to stop offering.                                                                                  |
| `src/main/server-output.ts`         | The child's stderr, **made safe to show** — bounded ring buffer, secret redaction, line truncation.                                                                                                            |

**Any exit nobody asked for is a crash** — including exit 0 and a `null` code from a signal. Exit 0 is not evidence that anybody asked: the dev orphan watchdog leaves that way, and `POST /api/admin/restart` and "Reset All Data" used to produce it here, until the server started answering both with a 409 under `DORKOS_MANAGED_BY` (ADR `260726-234120`; that refusal is a stop-gap and DOR-542 is meant to route both back through this supervisor). The supervisor logs it _before_ looking for a window (`BrowserWindow.getFocusedWindow()` is `null` whenever the app isn't frontmost, which used to skip the whole handler), offers restart-or-quit anchored to the tracked main window, and nulls the port so `getServerPort()` never hands the renderer a dead one. **Read the port through that accessor; never keep a copy.** `startServer` re-runs `chooseServerPort()` on every start including a crash-restart, so the port a restart lands on is usually the same one and is not guaranteed to be — a cached copy is wrong exactly when something has already gone wrong.

**A pin and a default get opposite answers** (`server-port.ts`, DOR-539). 4242 is a starting guess, so a conflict there steps up through the next nine ports. A port someone _chose_ — `DORKOS_PORT`, or a `server.port` that differs from the schema default — is a commitment other tools are already configured against, so a conflict there throws `PortUnavailableError` and says so, exactly as the CLI does. Do not "fix" the asymmetry by making the desktop refuse on 4242: the rule is about whether anyone expressed a preference, not about which surface you are on, and a desktop user who hits a refusal gets a dialog and no app rather than a terminal they can retry in.

Two things this module deliberately does **not** decide. It does not decide whether the server may run at all — two servers sharing one data directory is the instance lock's question (ADR `260726-234122`), answered in the server's own words, so the scan stays silent on the success path and the only conflict a person sees is the one that actually stopped them. And it no longer has to pick an obscure port for safety: `/api` is behind the `Host` guard (ADR `260726-232221`) and the local-only routes read the socket peer (ADR `260726-232222`), so the port can be chosen for people instead of for obscurity.

**Say what the server said.** A server that refuses to boot writes the actionable sentence to stderr and exits — a data directory another process already holds (the server-side instance lock, DOR-532), a failed migration, a port it could not bind. `server-output.ts` keeps a bounded, redacted tail of that stream, and both the startup-failure error and the crash dialog carry it. Pass it through verbatim: never parse it, match on it, or reword it. **The desktop side owns delivery only** — the server owns the wording, and nothing here knows or cares which failure it is.

Two things shape that tail, and both were chosen against real output rather than a guess:

- **A head as well as a tail.** A real failure is one reason line followed by a stack, and Node's default `Error.stackTraceLimit` is 10 — so a pure tail keeps frames and evicts the only sentence worth reading. Frames (`^\s*at `) are dropped outright too; `electron-log` still gets the whole trace.
- **Chunk boundaries do not respect lines.** The trailing partial is carried until its newline arrives, because splitting each `data` event independently would cut a token in half and neither piece would look secret-shaped any more.

Redaction goes through `scrubMessage` from `@dorkos/shared/error-report` — the repo's shared, maintained redactor — not a local regex. It also rewrites `/Users/<name>/…` to `~/…`, which matters for a dialog someone may screenshot. The audit behind this found no server module that logs a credential _value_ today; the reason to redact anyway is that `apps/server/src/index.ts` hands raw SDK errors from credentialed calls to `logger.warn`, and nobody owns that text.

**A retry that keeps failing stops being offered.** After `MAX_RESTART_FAILURES` failures the crash dialog drops "Restart Server" and offers "Open Logs" plus "Quit". Some failures cannot be retried out of, and an unlimited retry button against a locked data directory is a button that can never succeed. **A failure is not just a restart that would not start** — a server that starts and then dies inside `MIN_HEALTHY_UPTIME_MS` counts too, because the loop this cap exists to stop is usually a server that boots fine and is killed again by whatever killed it the first time. Only a server that stays up that long clears the counter; do not "simplify" this back to resetting whenever a server starts, which is the bug (DOR-533).

Three env facts worth knowing, all set in `buildServerEnv`.

- **`DORKOS_MANAGED_BY=desktop`.** `apps/server` answers `POST /api/admin/restart` and `/api/admin/reset` with a 409 (`MANAGED_BY_DESKTOP`) when it sees this — those endpoints re-exec the server process, which cannot work inside a UtilityProcess whose lifecycle the shell owns. This module only sets the variable; the gate is a `router.use` on the server side, deliberately not per-path. See **ADR `260726-234120`**, which also names the follow-up (DOR-542) that is meant to replace the refusal by routing both actions through this supervisor rather than building alongside it.
- **`DORK_HOME`** is pinned to `~/.dork` **only** when `app.isPackaged`. In dev the child resolves its own project-local `.temp/.dork`, so `pnpm --filter @dorkos/desktop dev` never migrates production data. Note the interaction with the server-side instance lock (ADR `260726-234122`): one server per data directory, so a packaged app and a `dorkos` CLI both pointed at `~/.dork` is now a refusal at boot with a readable reason, not silent mutual corruption.
- **`DORKOS_PARENT_PID`** is set in **dev only**, and is `delete`d from the packaged child's env rather than merely omitted — a packaged app inherits whatever the launching shell exported, and an inherited stale pid would arm the child's orphan watchdog (`exitWhenOrphaned`, `src/server-entry.ts`) against a process that is already gone, so the child would exit 0 a poll later and the shell would report a crash it caused itself. The child cannot derive this itself: `tsx` runs the server as a _grandchild_, so its `process.ppid` is the tsx wrapper. A packaged build needs none of it, because Electron tears a UtilityProcess down with the app.

### The server bundle is a separate build step

`electron-vite build` compiles **only** main/preload/renderer. It does **not** compile `src/server-entry.ts`. The desktop `build` script therefore runs `electron-vite build && tsx scripts/build-server.ts`, and `build-server.ts` (esbuild, mirroring `packages/cli/scripts/build.ts`) emits `dist/server/server-entry.mjs` with the native modules + agent SDKs marked external. Skip this and the packaged app forks a file that doesn't exist and dies windowless.

That bundle carries two gates, both of which fail the build (DOR-536):

- **No esbuild warnings.** esbuild reports this app's most expensive failure class — a bundle that builds green and dies only in a packaged install — as _warnings_: an unresolvable dynamic `require`, `import.meta` in the wrong output format, an external that never resolves. `ALLOWED_WARNING_TEXTS` in `build-server.ts` is the allowlist and is empty; adding to it requires quoting the warning and saying why it's safe.
- **Every runtime specifier resolves _and ships_.** After a successful build the script `node --check`s the emitted `.mjs`, resolves every external the metafile says it left in the output (plus the two `require`-routed natives, which esbuild can't see) from the bundle's own directory, and then checks each one's package is a declared `dependencies`/`optionalDependencies` entry. Both halves are needed: at build time `dist/server/` sits inside the source tree, so resolution also reaches devDependencies and the repo root — a devDependency would resolve happily here and be absent from the packaged app, since electron-builder packs only the production tree.

The same warning gate now guards `packages/cli/scripts/build.ts` — same module graph, same external list, and it's the launch-critical surface. Keep the two copies in step.

Both gates stop at resolution and never _evaluate_ the bundle — evaluating it would boot the server (port + `~/.dork`) and `dlopen` the native modules, which after a `rebuild-natives.ts` run would wedge the build under system Node. The packaged runtime is exercised for real by `scripts/smoke-packaged.ts` (§4) instead.

### The window loads from localhost, not file://

In production the main window loads `http://localhost:<serverPort>` — the bundled server serves the built SPA via `express.static`. It does **not** use `loadFile('…/index.html')`. Reason: a `file://` page sends `Origin: null`, which the server's CORS allowlist rejects, so a `file://` renderer can't call its own API. Serving both SPA and API from one localhost origin makes every request same-origin (and cookie auth works exactly as in the web cockpit). See **ADR `260712-005315`**. The main process passes the server child `CLIENT_DIST_PATH` pointing at the asar-**unpacked** renderer.

### Native binaries must be unpacked from asar

A Mach-O binary cannot be `dlopen`ed/executed from inside `app.asar`. So `electron-builder.yml` `asarUnpack`s:

- `better-sqlite3` and `node-pty` (native `.node` addons),
- `dist/renderer/**` (`express.static` can't range-read from inside asar),
- **three** families of per-platform binary package, each with `…-darwin-arm64/**` and `…-win32-x64/**` globs: `@anthropic-ai/claude-agent-sdk-*` (the `claude` executable), `@openai/codex-*` (the vendored Codex CLI) and `@esbuild/*` (the compiler the extension host runs). `@anthropic-ai/claude-agent-sdk/**` itself is unpacked too. See §3,
- `core-extensions/**` (staged into `DORK_HOME` via `fs.cp`).

Unpacking is the **only** way to put a file outside the asar. Do not add a second copy via `extraResources`: the server bundle resolves `node_modules` by walking up from `app.asar/dist/server/`, so it reaches `app.asar/node_modules/<pkg>` (asar-redirected to the unpacked copy) before it could ever see `resources/node_modules/<pkg>`. A duplicate there is unreachable weight that only surfaces the day the two copies carry different ABIs and someone debugs a `NODE_MODULE_VERSION` error against a binary they didn't know existed. One such copy of `better-sqlite3` was carried from the first desktop commit until DOR-536 removed it.

### What goes into app.asar

`electron-builder.yml`'s `files` is an explicit allowlist: `package.json`, `dist/**`, `core-extensions/**`. Without it, electron-builder's default packs essentially the whole package directory — which used to ship `src/` (including `src/main/__tests__/`), both build `scripts/`, `.turbo/turbo-build.log` and the tsconfig/eslint/vitest/electron-vite configs to every user.

`node_modules` is deliberately **not** in that list. electron-builder derives it from the production dependency tree with its own copier and reads only _negative_ patterns from `files`, so a positive entry would do nothing. **If you add a runtime read of a new top-level path, add it to `files`** — a missing entry packages green and fails only once installed. `pnpm --filter @dorkos/desktop pack` plus `npx @electron/asar list …/Resources/app.asar` is how you check.

### Native ABI rebuild happens at packaging time only

`better-sqlite3`/`node-pty` are compiled for **system Node** in the pnpm store (so dev + vitest work). Packaging needs them compiled for **Electron's** ABI. That rebuild:

- runs in the `pack`/`dist` scripts and the release workflow — **never** in a plain `pnpm build`. Putting it in `build` flips the store-shared binary to Electron's ABI and breaks plain-Node vitest across the whole monorepo — see the gotcha below.
- is done by `scripts/rebuild-natives.ts` calling `@electron/rebuild` **directly**. `electron-builder`'s own `npmRebuild` is disabled (`npmRebuild: false`) because it was observed producing a `better-sqlite3` that passed size/hash checks yet failed to `dlopen` with a misleading `NODE_MODULE_VERSION` error.

### ⚠️ Vitest gotcha: "Worker exited unexpectedly" means a poisoned better-sqlite3

If `pnpm --filter @dorkos/desktop pack` or `dist` has run on this machine (both run `rebuild-natives.ts` first — or you ran `rebuild-natives.ts` directly), the shared `better_sqlite3.node` in the pnpm store is now compiled for Electron's ABI, not system Node. macOS code-signing enforcement then kills every plain-Node `dlopen` of it: the process exits **137** with **"Code Signature Invalid"**, one level below anything Vitest itself can catch or report.

**Symptom:** Vitest workers die silently — `Worker exited unexpectedly`, no assertion failures — in every package whose tests load the shared better-sqlite3 binary: mesh/relay/client via `@dorkos/db`, site via better-auth's drizzle adapter. The pre-push test gate then blocks every push, with nothing in the output pointing at Electron packaging as the cause.

**Fix:** `pnpm rebuild better-sqlite3 node-pty` from the repo root. Re-run it any time you package the desktop app locally — packaging re-poisons the shared binaries.

## 3. Bundling the tools the app runs on

### 3.1 The pattern, once

Three separate things the packaged app needs are published the same way: as a **per-platform package holding one executable**, hung off a parent package as an _optional_ dependency. pnpm nests those, and **electron-builder's production-tree copier does not reach a nested optional dependency** — so declaring the parent is not enough. Every one of them needs all three of:

1. an os/cpu-guarded entry in `apps/desktop/package.json`'s `optionalDependencies`, which is what puts it at the desktop package's own top level where the copier finds it,
2. an `asarUnpack` glob in `electron-builder.yml`, because an executable cannot run from inside `app.asar`,
3. a version pinned to whatever it carries the executable **for**.

`scripts/build-server.ts` enforces (3) on every build (`assertPlatformBinariesLocked`) — a skewed pin installs cleanly, packages green, and only shows up in an installed app.

| Package                                 | Carries                       | Locked to                        | Reached at runtime via                            |
| --------------------------------------- | ----------------------------- | -------------------------------- | ------------------------------------------------- |
| `@anthropic-ai/claude-agent-sdk-<plat>` | `claude` / `claude.exe`       | `@anthropic-ai/claude-agent-sdk` | `DORKOS_CLAUDE_CLI_PATH` from `server-spawn.ts`   |
| `@openai/codex-<plat>` (an npm alias)   | `vendor/<triple>/bin/codex`   | `@openai/codex`                  | `@openai/codex-sdk`'s own `require.resolve` chain |
| `@esbuild/<plat>`                       | `bin/esbuild` / `esbuild.exe` | the resolved `esbuild` version   | `ESBUILD_BINARY_PATH` from `server-spawn.ts`      |

Only two of the three were wired before DOR-1335. The shipped 0.61.0 Mac app therefore had **no Codex runtime at all** (the SDK threw `Unable to locate Codex CLI binaries` at construction and `registerOptionalRuntime` swallowed it) and **failed to compile its own bundled marketplace extension on every boot** (`The package "@esbuild/darwin-arm64" could not be found`).

The Claude binary adds ~213 MB to the DMG and the Codex one ~257 MB. That is inherent to "runs your coding agents out of the box"; the os/cpu guards keep each to the one target arch.

### 3.2 Why two of them are handed an explicit path

`require.resolve` inside a packaged app answers with an `…/app.asar/…` path even for an unpacked file — Electron's asar layer makes the file _readable_ there, not _spawnable_. Measured against the shipped app:

```text
require.resolve('@esbuild/darwin-arm64/bin/esbuild')
  → …/app.asar/node_modules/@esbuild/darwin-arm64/bin/esbuild
spawnSync(that path)      → ENOTDIR
execFileSync(that path)   → works        ← Electron patches execFile/execFileSync, NOT spawn/spawnSync
```

So anything that **spawns** its binary needs the real `app.asar.unpacked` path, and `server-spawn.ts` computes it and hands it over in the environment. esbuild spawns (`ESBUILD_BINARY_PATH`); the Claude SDK does too (`DORKOS_CLAUDE_CLI_PATH`).

**Each binary has ONE ladder server-side, and every caller walks the same one.** For Claude that is env override → SDK-bundled (remapped out of `app.asar` into `app.asar.unpacked` when needed) → provisioned → PATH, walked by both the SDK spawn seam (`resolveClaudeCliPath`) and the readiness probe (`resolveClaudeBinaryPath`). They used to differ, which is how the packaged app came to run sessions on a `claude` its own setup screen called missing (DOR-1334). Codex has the same shape (`resolveCodexBinaryPath`: config → vendored → provisioned → PATH) and does that asar remap itself, which is why nothing is handed to it from here — but the remap is load-bearing either way: without it the packaged app registers the Codex runtime and then reports its CLI as missing, because the vendored path it resolves is an `app.asar` one. Dev and the npm CLI are unaffected throughout: the env vars are unset and no path contains an asar.

### 3.3 Runtime resilience (optional runtimes)

Only claude-code and codex ship a binary. OpenCode is provisioned on demand. Optional runtimes' SDK constructors can **throw synchronously** when their CLI isn't present, so `apps/server/src/index.ts` wraps each optional runtime's construct-through-register in `registerOptionalRuntime` (in `runtime-registry.ts`), which logs a warning and continues. A missing optional-runtime CLI must **never** take down the server; if you add a runtime, route it through the same helper.

### 3.4 A launched-from-Finder app knows nothing about your machine

Two things the app cannot inherit, and has to work out for itself before it forks the server:

**PATH.** launchd starts a double-clicked app with `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — not `~/.local/bin`, not `/opt/homebrew/bin`, not any `~/.nvm/versions/…`. Every `which <binary>` rung in the server therefore failed in the Mac app for anything not bundled, while the same DorkOS started from a terminal found everything. `src/main/shell-path.ts` asks the user's own shell (`$SHELL -ilc …`, once per process, 5 s bound, SIGKILL on timeout, fall back to the inherited PATH and say so) and puts the answer in front of the inherited one. Two details are load-bearing:

- **`-i`**, because plenty of people export PATH from `~/.zshrc`, which a non-interactive shell never reads.
- **it asks for `env`, not for `"$PATH"`.** The variable's syntax differs between shells in a way that fails quietly — fish keeps PATH as a list, so `"$PATH"` expands space-separated there, which parses as one junk entry, gets prepended, and is logged as a success. `env` prints what a child spawned from that shell would actually receive, colon-joined in every shell including fish. Shells that reject the flags (tcsh, csh) print no marker and take the fallback.

An interactive shell also prints whatever the user's rc files print, so the dump is wrapped in `LOGIN_SHELL_PATH_MARKER` (`src/shared/login-shell-path.ts`) and the `PATH=` line read out of it. Skipped in dev and on Windows.

**Working directory.** `process.cwd()` for a Finder launch is `/`, and the server's own fallback derives a directory from its bundle location — `…/DorkOS.app/Contents/Resources`, outside the `$HOME` boundary. So `GET /api/directory/default` handed the client a path its own boundary check refused, and every boot logged `runtime listing degraded … Access denied: path outside directory boundary`. `src/main/server-cwd.ts` decides instead, mirroring the CLI's precedence — **environment variable, then `config.json`, then the boundary root** — and applying it to `DORKOS_DEFAULT_CWD`/`server.cwd` and `DORKOS_BOUNDARY`/`server.boundary` alike. The answer goes down as `DORKOS_DEFAULT_CWD` _and_ as `utilityProcess.fork`'s `cwd`.

Both halves of that symmetry were bought:

- **Read both variables or neither.** The child inherits this process's environment wholesale, so an exported `DORKOS_BOUNDARY` reached it whether or not the shell looked at it, while an exported `DORKOS_DEFAULT_CWD` was silently overwritten. Reading only one reproduced the very bug this exists to fix: launch from a shell exporting `DORKOS_BOUNDARY=/tmp/scope` with nothing in `config.json`, and the shell clamped against home, sent `DORKOS_DEFAULT_CWD=$HOME`, and the child refused it.
- **The clamp resolves symlinks and requires the directory to exist**, in that order. The server's boundary check compares canonical paths (`initBoundary`/`resolveCanonicalPath`), so a lexical check passes a `~/work` symlinked onto an external volume that the server then refuses; and a stale pin reaching `fork`'s `cwd` is not a wrong directory but a failed spawn, i.e. an app that does not start at all.

## 4. Running & testing locally

```bash
pnpm --filter @dorkos/desktop dev        # electron-vite dev; server child via tsx
pnpm --filter @dorkos/desktop build      # electron-vite build + build-server.ts
pnpm --filter @dorkos/desktop test       # vitest; electron is vi.mock'd (src/main/__tests__/electron-mock.ts)
pnpm --filter @dorkos/desktop typecheck
pnpm --filter @dorkos/desktop lint

# Package a signed app locally (uses your keychain Developer ID identity):
cd apps/desktop && npx electron-builder --mac --arm64 --dir --config electron-builder.yml
```

Main-process code is unit-tested against a mocked `electron` module (`vi.mock('electron', …)`), never a live Electron. Keep that harness green; there is no e2e for the main process.

### Smoke-testing the packaged runtime

Everything between "the bundles emit" and "the app works" is unreachable by unit tests, and it is where the expensive bugs live (a dead server port after a restart, a stale renderer URL, a wrong window state — all shipped, all found by hand). `scripts/smoke-packaged.ts` launches the packaged app, waits for its server to answer `/api/health` on the port it actually opened (discovered via `lsof` over the app's process tree, so no log-format coupling), asserts the reported version matches `apps/desktop/package.json` (proving it's serving the bundle you just packaged) and that the packaged bundle id matches `appId`, then quits it and asserts a clean exit 0 with the port released rather than orphaned.

**It is safe to run on your own machine**, and that took care: the run boots a full production server for up to two minutes, so without isolation it would run the _packaged_ migration set against your real `~/.dork/dork.db`. Setting `HOME` is not enough — Electron's `app.getPath('home')` resolves through CoreFoundation's `NSHomeDirectory()`, which ignores `$HOME`, and `server-process.ts` builds `DORK_HOME` from it. Measured:

```text
HOME=/private/tmp/fakehome   →  getPath(home) = /Users/<you>          ← your real home
+ CFFIXED_USER_HOME=…        →  getPath(home) = /private/tmp/fakehome
```

So the script sets **both** (`HOME` steers Node's `os.homedir()`, `CFFIXED_USER_HOME` steers Electron's `getPath`) and then asserts the SQLite store really landed in the throwaway tree. Half isolation is worse than none — it looks contained while writing to the real database, and CI can't catch it because a runner's home is disposable. Don't drop either variable or the assertion.

```bash
pnpm --filter @dorkos/desktop exec tsx scripts/rebuild-natives.ts
cd apps/desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir --config electron-builder.yml
pnpm --filter @dorkos/desktop exec tsx scripts/smoke-packaged.ts

pnpm rebuild better-sqlite3 node-pty   # ← from the repo root. Not optional. See §2.
```

In CI this is `.github/workflows/desktop-smoke.yml` — a single macOS job (unsigned `--dir` pack, so it needs no Apple credentials), ~6 minutes end to end, running on PRs that touch `apps/desktop/**` and on pushes to `main` that touch the server, client or workspace packages. That asymmetry is deliberate — macOS runners are capped, and the server-bundle half of the risk is already covered on PRs by the ubuntu CLI smoke test; the workflow header explains it in full. The job runs **no tests** on purpose — it rebuilds the native modules for Electron's ABI, and that must never share a runner with vitest (§2).

One thing that surprises people: an **unsigned** build cannot launch as packaged. `hardenedRuntime: true` turns on library validation, and electron-builder ad-hoc-signs each binary separately, so the loader rejects the app's own Electron Framework with _"…different Team IDs"_. The smoke re-signs ad-hoc in one pass when (and only when) it finds an ad-hoc signature — a real Developer ID signature is never touched.

## 5. The window & app lifecycle

### Closing the window does not quit (DOR-538)

**The app keeps running when its last window closes, so agents keep working.** The server is a child process the shell supervises, and it is where agent turns actually run — a closed window is a closed view, not a stopped machine. This replaced a split where macOS stayed alive with zero windows and Windows quit outright: same product, two behaviours, neither of which told the person anything.

The rule is deliberately not "which OS is this":

```ts
app.on('window-all-closed', () => {
  if (!hasTray()) {
    app.quit();
    return;
  } // no way back → do not linger invisibly
  void announceBackgroundRunning(); // say it, once, ever
});
```

**Never leave the app running with no window and no icon.** `hasTray()` is false on a platform with no tray image (Linux, which has no shipped build) and when the image fails to decode, and both cases fall back to quitting. An unreachable running app is worse than an app that quit.

The window is **destroyed** on close, not hidden. Reopening remounts a fresh renderer, which is fine: session state lives on the server, and the durable per-session SSE stream replays on reconnect. Hiding would keep a renderer (and its memory) alive behind a window the person believes they closed, and would stop `window-all-closed` firing at all.

`background-notice.ts` owns the one-time "DorkOS is still running" dialog, keyed off `userData/shell-notices.json`. It offers **Quit DorkOS** as well as **Got It** — someone who closed the window meaning to quit should not have to go hunting.

### The tray

`tray.ts`. Created once in the `ready` sequence on every platform that has a tray image; it is what makes the paragraph above safe. Its menu is the activity summary (a disabled line, not a button), **Open DorkOS**, **Activity**, and **Quit DorkOS**. Quit routes through `app.quit()` so it meets the same confirmation as every other exit.

Activity is reflected calmly and never with colour or notifications: the tooltip everywhere, plus `tray.setTitle(count)` on macOS — the only platform that shows text beside a tray icon. Windows has no equivalent, so the tooltip carries it alone. Windows also gets a left-click handler that opens the window; macOS deliberately does not, because once a context menu is attached macOS opens it on any click, and a `click` handler there would fire the window _and_ the menu.

**`src/shared/tray-images.ts` is the one list**, read by both `tray.ts` (which image to load) and `electron.vite.config.ts` (which files to copy). Adding a platform to one and not the other packages green and produces an app with no tray on whichever platform was missed — a runtime-only failure. Images come from `build/` but are **read from `dist/main/`**: `build/` is electron-builder's `buildResources`, which is not packaged, and `electron-builder.yml`'s `files` allowlist ships only `dist/**`. The `emitTrayImages()` plugin bridges the two, so `join(__dirname, name)` resolves identically in dev and packaged. macOS gets `trayTemplate.png` (the `Template` suffix is load-bearing — it is what makes macOS recolour the glyph for light and dark menu bars); Windows gets `trayIcon.png`, a **PNG and not the `.ico`**, because Electron's `.ico` decoder is Windows-only and a `.ico` tray asset cannot be verified anywhere else. Linux has no entry at all: there is no Linux build, and a tray there needs a `libappindicator` host that cannot be assumed. See `build/README.md` to regenerate.

**Verification status, for anything you write about this in user-facing copy:** the tray and the background-running behaviour it guards are verified on macOS. On Windows they are built and code-reviewed only — the Windows build has not been confirmed by a real end-user install (`meta/positioning-202607/09-gtm-plan.md` §2.0). The degradation is at least safe by construction: no tray means `hasTray()` is false, which means the app quits on last-window-close rather than vanishing.

### Quitting goes through one door

`quit-guard.ts` owns `before-quit` — the single funnel every exit reaches (Cmd+Q, the menu, the tray, the Dock, `autoUpdater.quitAndInstall()`, the crash dialog). An ordinary quit is intercepted once: it confirms when agents are mid-run, then stops the server, then re-issues the quit, and the second pass is let through by the `quitting` latch.

**An update restart is the exception, and it is not optional.** When `consumeUpdateRestart()` says this quit is one, the handler does not `preventDefault()` at all: the restart already asked, recorded and stopped the server before calling the installer (see §5), so there is nothing left to do — and cancelling the termination Squirrel armed its install against is what a person's ten days of updates died on.

**Do not add a second `before-quit` listener that latches.** `server-crash-recovery.ts` used to have one, and it was correct only while a quit could not be cancelled: now that one can, a latched flag would silently disable crash recovery for the rest of the session the moment someone chose "Keep Working". Ask `isQuitting()` instead.

### Knowing what the agents are doing

`event-stream.ts` owns the **one** connection to the server's global `GET /api/events` stream — the same one the cockpit uses, so there is no polling and no dependency on a window being open — and hands every frame off it to however many subscribers are watching. `agent-activity.ts` and `notifications/index.ts` (DOR-1386) are both subscribers today, sharing the one connection rather than each opening its own: two independent HTTP clients polling the same SSE stream would double the server's fan-out work for every event, for no benefit. `event-stream.ts` reconnects with backoff, re-reading the port each attempt because crash recovery restarts the server onto whatever port it wins that time, which is usually but not always the previous one — and isolates each subscriber's callback in a try/catch, so one subscriber's bug is logged and never stops another subscriber, or crashes the main process.

`agent-activity.ts` counts sessions whose `status.lifecycle` is `streaming` or `blocked` (a session paused on your approval is mid-turn, and the one you would most hate to lose). `notifications/index.ts` shows a native OS notification for a Blocking Ask (always) or Notable activity (only while no window has focus) — see ADR `260819-234830` for the tiering and `notifications/answer.ts` for how an Allow/Deny/Reply click answers the Ask over the same routes the cockpit's own buttons call.

The stream carries **transitions only, with no snapshot on connect**. That is exact in practice — subscribers attach as the server comes up, before any session can start — and after a reconnect `agent-activity.ts` deliberately under-reports, because a stale count that never clears would nag about finished agents and block quitting forever.

### Windows, plural

`window.open` at the app's own origin opens a **real second cockpit window** (`window-manager.ts`'s window-open handler), built here rather than returned as `{ action: 'allow' }` so it gets the same preload, sandboxing and link guards as its opener. Everything else is still denied a window; `http(s)` goes to the system browser.

This `http(s)`-only rule is the desktop shell's own layer on top of the client-wide link scheme allowlist; see [`link-dispatch-policy.md`](link-dispatch-policy.md) for the full policy and how the two relate.

Three things are scoped to the **primary** window on purpose, and a second window does without them:

| Scoped to primary                          | Why                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Window geometry (`window-state.ts`)        | Two writers on one JSON file would overwrite each other; a second window cascades off the focused one and is not remembered. |
| `dorkos://` deep links and menu navigation | `navigation.ts` tracks one ready renderer and one pending path; `index.ts`'s `isTrackedRenderer` guard rejects the rest.     |
| The "restart to install" update card       | Same guard on `get-update-status`. The card appears in the primary window.                                                   |

A server crash-and-restart **does** move every window to the port the server came back on (`pointWindowsAtServer`), because a second window left on a dead port has no way to recover but being closed. Keep this even though the restart usually re-wins the same port — "usually" is not a guarantee, and the failure it prevents is a window that can never recover.

### `Cmd/Ctrl+W` delegates to the renderer

The cockpit has in-renderer tabs (DOR-540), so the accelerator asks the focused renderer first (`close-tab.ts`). `CmdOrCtrl+Shift+W` ("Close Window") stays unconditional.

**The tabs themselves are not a shell feature.** They live in one renderer as router state (`apps/client/src/layers/features/app-tabs`, `shared/model/app-tabs`), not a `WebContentsView` per tab — every tab points at the same trusted local origin, so a process each would buy isolation nothing here needs and pay for it in memory. macOS native tabs were never on the table: mac-only, and incompatible with the `hiddenInset` title bar. The shell's entire involvement is this one accelerator. `Cmd/Ctrl+T`, `Cmd/Ctrl+1-9` and `Cmd/Ctrl+Shift+[`/`]` are registered on `document` by the renderer and never reach here — see `contributing/keyboard-shortcuts.md`.

**They are a desktop-app feature even so** (DOR-568). Living in the renderer means the code _can_ run in the browser cockpit; it does not, and must not. The renderer gates the strip, the chords and the palette's "Open in New Window" on `isDesktopShell()` — the preload bridge, any platform — because a browser already has tabs, and ours are the worse pair: not individually bookmarkable, not restored by the browser's own session restore, not draggable into their own window. Shipping both stacked two tab bars on one window. In a browser `target: 'tab'` opens a real browser tab instead.

The menu item is labelled **"Close Tab"** since DOR-540, which is the change that shipped the renderer's half. The cockpit subscribes for the whole life of the shell and answers truthfully each time: `closeActive()` returns `false` on the last tab, which is exactly what lets the window close. Chrome's "Close Tab" behaves the same way, so the label is honest in both cases, and "Close Window" remains for closing the window outright.

**Subscribing is what claims the keystroke.** A renderer announces itself on `close-tab:subscribe` when it first calls `onCloseTab`; with no subscriber the window closes immediately, no message and no wait — exactly what Cmd+W did before tabs, and still what happens in a window whose renderer has not mounted (a second cockpit window mid-load, `electron-vite preview`). Only a subscribed renderer gets asked, and only then does the 3-second timeout apply.

**Do not re-gate the subscription on the tab count.** `use-electron-close-tab.ts` subscribes on mount and unsubscribes on unmount, unconditionally; the last-tab rule lives in the _answer_. Moving it into the subscription states one rule in two places and leaves the shell's behaviour depending on which copy is right.

That gate is what lets the timeout be generous. An ack runs on the renderer's main thread, which a streaming turn can block well past a snappy budget, and giving up early destroys a window full of tabs nobody asked to lose. Without the gate, a budget long enough to be safe would be a delay on _every_ Cmd+W in every window that was never going to answer.

The timeout is still the design, not a safety net: a person pressing Cmd+W must never get nothing — not when the renderer is wedged, not when it threw. Nothing waits on the renderer; it is a race the window always eventually wins. The renderer-facing contract is documented in full on `onCloseTab` in `src/preload/index.ts` — **subscribe on mount, unsubscribe on unmount, do the work synchronously, and return `true` only if you closed a tab.**

### Quitting to install an update is not a normal quit

`autoUpdater.quitAndInstall()` **closes every window and only then calls `app.quit()`**. So `window-all-closed` fires first, and on that path the background notice must stay silent — otherwise clicking "Restart to install" produces "DorkOS is still running, so your agents keep working", complete with a Quit button, and burns the one-time notice for good. `isQuitting()` cannot catch it, because `before-quit` has not happened yet.

`auto-updater.ts` owns that state, and it asks about mid-run agents **before** arming the installer rather than from `before-quit` — by then the answer cannot change anything, because Windows has already run the installer and macOS may have handed off to Squirrel. `quit-guard.ts` takes it as an option rather than importing it, so it stays a leaf module. The wording differs from an ordinary quit ("Restart anyway?", not "Quit anyway?"), because telling someone who asked to install an update to close the window instead is advice that does not install their update.

**The order in `prepareUpdateRestart()` is the fix, not a tidy-up.** Ask → record the attempt → `await stopServer()` → arm → hand off. The server goes down _before_ the installer is called, precisely so the quit guard has nothing to do and can let the installer's quit run untouched.

**And stopping the server first is only safe because of the watchdog.** `MacUpdater.quitAndInstall()` quits only `if (this.squirrelDownloadedUpdate)`; on the other branch it registers a deferred listener and returns having issued nothing, and with `autoInstallOnAppQuit` true it does not even ask Squirrel to check. If Squirrel then fails the way it silently does, **nothing further arrives at all** — no quit, no `error`. The old code survived that by doing nothing; this one has already taken the server down, so a stall would leave a live window in front of a dead server for ever. So the handoff arms `STALLED_RESTART_TIMEOUT_MS` (15s), and both it and the updater's `error` handler restart the server, re-point the windows and push `install-failed`. If you ever move the `stopServer()` call, that recovery moves with it. A person spent ten days clicking "Restart to install" and getting the old version back every time, with no error anywhere, while the passive install-on-quit path eventually worked; the difference between the two was that ours cancelled the quit and issued its own (`plans/desktop-resilience-program.md` §2B). The price is that on the deferred macOS branch the window sits in front of a stopped server until Squirrel finishes — seconds of a page that cannot load, against a restart that silently never installs.

Two more things ride the same launch. `updater/cache.ts` deletes a staged update the running version has already caught up with, before the first check runs: left alone it is re-offered to Squirrel on every quit for ever, and after someone installs a fresh copy by hand — the support remedy for a wedged updater — it would hand them a downgrade. **It resolves its two directories by identity and refuses to act without one**, because `~/Library/Caches` holds a `.ShipIt` for every Squirrel app and a `-updater` for every electron-updater app on the machine: finding ours by suffix — which is right for the diagnostic report, and is where that code came from — finds Slack's, Cursor's and Claude's too, including downloads in progress. Our bundle id comes from our own `Info.plist` and our cache directory from `updaterCacheDirName` in the packaged `app-update.yml`. The tests keep a fixture of four other apps' state that must survive every case; do not remove it. `updater/manual-overwrite.ts` covers the other half of that remedy: DorkOS stays alive with its window closed, so drag-installing a new version leaves the old process running and the single-instance lock turns "open the new one" into "focus the old one". On a second launch and on window focus it compares the bundle's `Info.plist` version with `app.getVersion()` and, if disk is newer, offers a restart into it — once per version, and asking about mid-run agents **before** `app.relaunch()`, because `relaunch()` is a standing instruction for the next exit and declining afterwards would leave the app primed to reopen itself on an unrelated quit.

**Two states, not one, because the two consumers have opposite tolerances.** One flag serving both is what broke here twice.

| State                                     | Consumer              | Set too long                    | Cleared too early                           |
| ----------------------------------------- | --------------------- | ------------------------------- | ------------------------------------------- |
| `restartArmed` (`isRestartingToUpdate()`) | the background notice | notice waits for the next close | **notice appears mid-update, and is spent** |
| the confirmation, timestamped             | the quit guard        | **agents killed silently**      | one extra dialog during an update           |

So `restartArmed` never expires on its own, and the confirmation is spent on use (`consumeUpdateRestart()`) and times out if it is never spent. Both clear on an updater `error`, which is how a rejected update ends.

The asymmetry is only that stark because of where the ledger is written: `announceBackgroundRunning` returns _before_ writing when the notice has already been shown, so suppressing the call defers the notice rather than consuming it. Showing it at the wrong moment is what consumes it. Keep that ordering.

**`quitAndInstall()` does not always quit, and "deferred" is not "did not happen".** Read `node_modules/electron-updater` before changing this:

- `MacUpdater.quitAndInstall()` quits only `if (this.squirrelDownloadedUpdate)`. Otherwise it registers a deferred `update-downloaded` listener and **returns with the app alive** — and the restart still happens, later, when Squirrel finishes. That flag is set long after the `update-downloaded` that raised the in-app card, so the gap between the card appearing and Squirrel finishing is exactly when someone clicks the button. **Treating that branch as "the restart did not take" puts the notice back in the middle of the update**, which is the bug this section exists to describe.
- `BaseUpdater.quitAndInstall()` (Windows) skips `app.quit()` entirely when `install()` returns false.

Electron's own `autoUpdater` emits `before-quit-for-update` as the install-quit begins, including on the deferred branch, and that re-authorises a restart slower than the timeout. It is a refinement, never the mechanism: it is verifiable in `BaseUpdater.js` (emitted by hand) and Electron's MSIX updater, but on macOS it comes from the C++ binding and could not be verified from the repo. Nothing depends on it firing.

**And never let any of it skip a quit.** `window-all-closed`'s `if (!hasTray()) app.quit()` is unconditional, because "running with no window and no tray" is the one state this design exists to prevent, and no flag may be able to produce it. The state may silence the notice; it may not stop the quit.

### First paint

Windows are created with `show: false` and a `backgroundColor` matching the cockpit's own, then revealed on `ready-to-show` (with a 4-second fallback, because a window that never appears is far worse than a flash). `maximize()` has to happen in that reveal, not at construction — a hidden window maximized at construction opens un-maximized on macOS.

### The window that cannot stay black (`renderer-health/`)

Revealing a window says nothing about whether anything is **on** it. v0.63.0 shipped a renderer bundle that threw before React mounted, and every install came up as a black rectangle that nothing retried and nothing logged (DOR-1448). `renderer-health/` supervises the renderer the way `server-process.ts` supervises the server child.

- **Health is a heartbeat.** The renderer reports over the preload bridge (`reportAlive`), fired from **both** exits of the boot sentinel in `apps/client/index.html` — the mounted app, and the panel it paints when the bundle failed. The question is "is anyone looking at a black rectangle", and a panel that names the error is a no. Silence for 10s is a failure, and so are `did-fail-load` (main frame, not `ERR_ABORTED`), `render-process-gone` (not `clean-exit`) and `unresponsive`. A GPU or network-service crash is logged but never ladders on its own — Chromium respawns both.
- **Recovery escalates on a counter that survives a restart** (`userData/renderer-health.json`, plus an in-memory copy so an unwritable disk cannot pin the ladder at rung 1): reload → clear the HTTP cache and reload → clear the GPU/code caches and relaunch with hardware acceleration off → stop healing and load the bundled recovery page. Rung 3 **asks before it arms** (`confirmInterruptingAgents('restart')`), because `app.relaunch()` arms the _next_ exit whenever it happens — arming first and being declined leaves a relaunch primed for someone's next deliberate Cmd+Q.
- **A rung yields out of the failing event's stack before touching the window.** Reloading from inside `render-process-gone` takes the whole main process down with `SIGTRAP`; one turn later it recovers cleanly. Measured against a real Electron — no mocked test can see it.
- **"Showing the recovery page" is derived from the live URL, never latched.** Other modules navigate this window (`server-crash-recovery.ts` points every window at the restarted server), and a stale flag would both switch the ladder off for the session and expose the page's storage-wiping actions to the cockpit — where third-party extension code runs.
- **A slow load is not a failed load.** A deadline that expires while `webContents.isLoading()` re-arms up to a 60s ceiling: reloading a slow load restarts it from zero, forever.

**Fault injection.** Set `DORKOS_DESKTOP_SUPPRESS_HEARTBEAT=1` and the supervisor ignores every heartbeat, so a perfectly healthy renderer walks the whole ladder to the recovery page. It lives in the main process rather than the preload so the shipped bridge carries no test-only branch, and so the injection covers a renderer that goes quiet for **any** reason. Pair it with `webContents.forcefullyCrashRenderer()` to exercise rung 1.

## 6. ⚠️ Runtime-QA gotcha: a "hung" packaged launch is almost always Gatekeeper

**Read this before spending an hour concluding a build is broken.** When you launch a freshly-downloaded (quarantined) **notarized** build from the terminal and it appears to hang, it is almost certainly the macOS Gatekeeper first-launch consent dialog — _"'DorkOS.app' is an app downloaded from the Internet. Are you sure you want to open it? Apple checked it for malicious software and none was detected."_ — which **blocks the launch until a human clicks Open**. Headless, that is indistinguishable from a crash/hang:

- process alive but **0% CPU**, `S` (blocked) state;
- **zero** Electron helper processes ever spawn;
- **nothing** in stdout or `~/Library/Logs/@dorkos/desktop/main.log`;
- even a trivial `ELECTRON_RUN_AS_NODE=1 …/Contents/MacOS/DorkOS -e "console.log(1)"` hangs;
- `sample` shows only `_dyld_start` — a **sampling artifact** of hardened runtime blocking introspection, **not** an actual dyld hang.

It is **not** a code or signing defect (the dialog literally confirms notarization passed). Two ways forward:

1. **Real-user path**: double-click the app in Finder and click **Open** once. Trusted thereafter.
2. **Automated / CLI QA**: strip **all** quarantine attributes first —
   ```bash
   xattr -cr /Applications/DorkOS.app
   ```
   Note `xattr -dr com.apple.quarantine` alone is **not** enough: `com.apple.macl` and `com.apple.provenance` also re-trigger the dialog. Use `-cr` (clear recursive).

After clearing, a healthy launch shows Electron helpers within ~1s, a listening server port, and `[RuntimeCache] warm-up populated model cache { count: N }` in the log. (Verified end-to-end 2026-07-12; this exact confusion cost hours before it was root-caused.)

## 7. Signing, notarization & releasing

**The desktop build rides the unified product release.** There is no separate desktop tag scheme — the `.github/workflows/desktop-release.yml` workflow triggers on the `v*` product tags that `/system:release` creates. When that command bumps `VERSION` (and `apps/desktop/package.json` alongside it), tags `vX.Y.Z`, and pushes, the workflow builds the macOS app and **attaches** the `.dmg` + `.zip` + `.blockmap` + `latest-mac.yml` to the GitHub Release the command already created. It does not create its own release or rewrite the notes. To release the desktop app you just run `/system:release` — do **not** push a standalone tag. (For a manual/verification build without publishing, use the workflow's `workflow_dispatch` with `dry_run`.)

Because the desktop build runs as a **separate workflow** from the release that `/system:release` cuts, a build or notarization failure can never block or unwind the product release — the release and its notes exist the moment the tag is pushed; the macOS assets attach later (or not, on failure). Fail-soft by construction. First-ever notarization can take ~30–65 min, so the DMG typically appears on the release minutes-to-an-hour after the CLI release is live; `dorkos.ai/download/mac` starts resolving to it once it attaches.

Signing + notarization are **CI-driven**, gated on the `APPLE_DEVELOPER_CONFIGURED` repo variable in the same workflow. When configured, a build signs with the Developer ID cert (from `CSC_LINK`/`CSC_KEY_PASSWORD`), notarizes with Apple (`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`), and staples the ticket.

Gotchas worth knowing (details vary by machine; the setup itself lives with the maintainer's Apple account):

- **Building a `.p12` with OpenSSL 3.x needs `-legacy`**, or macOS `security import` fails with "MAC verification failed (wrong password?)".
- **First-ever notarization from a new signing identity takes ~30–65 min** ("In Progress"); subsequent ones are minutes. There is no web dashboard — use `xcrun notarytool history|log`. Notarization is an automated malware scan (24/7, weekends included), **not** App Store review.
- **The auto-update `.zip` must be published alongside the `.dmg`** — Squirrel.Mac (electron-updater) can only install updates from the zip; a dmg-only release 404s every update check. Its `.blockmap` must ship too, or updates silently fall back to a full download instead of a differential one.
- **App Store is deliberately not a target.** The app spawns shells and agent CLIs and writes across the filesystem — none of which fits the App Sandbox. It ships as a Developer-ID-signed, notarized direct download (like VS Code, Docker Desktop, iTerm). See the maintainer's notes / DOR-230 for the rationale.

Verify a packaged build actually launches and runs a session (§6) before treating a release as good — static checks and unit tests pass long before the packaged runtime is exercised. `desktop-smoke.yml` (§4) covers the "does it boot and serve" half automatically; running a real session in the packaged app is still a human step.
