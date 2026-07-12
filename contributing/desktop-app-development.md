# Desktop App Development Guide

> Developer reference for the DorkOS desktop app (`apps/desktop`) — a thin Electron shell that runs the same Express server and React client as the CLI cockpit, packaged as a signed, notarized macOS app.

---

## 1. What the desktop app is

`apps/desktop` is a **thin shell**. It does not reimplement the product — it starts the same `@dorkos/server` and loads the same `@dorkos/client` SPA that `dorkos` (the npm CLI) runs. Its job is native macOS integration: a real menu bar, single-instance behavior, window-state restore, `dorkos://` deep links, auto-update, and shipping the whole stack as one installable `.app`.

Build tooling: `electron-vite` (main/preload/renderer) + `electron-builder` (packaging/signing). Renderer root is `apps/client`. The app targets **macOS arm64** today (see `electron-builder.yml` `mac.target`).

```
apps/desktop/
├── src/main/            # main process: window-manager, server-process, menu, navigation, auto-updater
├── src/preload/         # contextBridge → window.electronAPI
├── src/server-entry.ts  # the server child's entry (imports @dorkos/server for its side effect)
├── scripts/
│   ├── build-server.ts     # esbuild-bundles server-entry.ts → dist/server/server-entry.mjs
│   └── rebuild-natives.ts  # @electron/rebuild for better-sqlite3 / node-pty (Electron ABI)
├── electron-builder.yml # packaging, signing, notarization, asarUnpack
└── electron.vite.config.ts
```

## 2. The packaging model (how it actually runs when installed)

This is the part that surprises people. Getting it wrong produces an app that builds fine and even launches under `electron-vite preview`, yet fails only in a real packaged install.

### The server runs as a child process

The main process spawns the Express server, not in-process:

- **Production**: Electron `UtilityProcess.fork` of the bundled `dist/server/server-entry.mjs`.
- **Development**: `child_process.fork` via `tsx` of the original `src/server-entry.ts` (system Node, so the shared `better-sqlite3` stays compiled for system Node and `pnpm dev` keeps working).

`src/main/server-process.ts` owns this: free-port allocation, env wiring, readiness handshake (`{type:'ready'}`), crash monitoring, and forwarding the child's stdout/stderr into `electron-log`.

### The server bundle is a separate build step

`electron-vite build` compiles **only** main/preload/renderer. It does **not** compile `src/server-entry.ts`. The desktop `build` script therefore runs `electron-vite build && tsx scripts/build-server.ts`, and `build-server.ts` (esbuild, mirroring `packages/cli/scripts/build.ts`) emits `dist/server/server-entry.mjs` with the native modules + agent SDKs marked external. Skip this and the packaged app forks a file that doesn't exist and dies windowless.

### The window loads from localhost, not file://

In production the main window loads `http://localhost:<serverPort>` — the bundled server serves the built SPA via `express.static`. It does **not** use `loadFile('…/index.html')`. Reason: a `file://` page sends `Origin: null`, which the server's CORS allowlist rejects, so a `file://` renderer can't call its own API. Serving both SPA and API from one localhost origin makes every request same-origin (and cookie auth works exactly as in the web cockpit). See **ADR `260712-005315`**. The main process passes the server child `CLIENT_DIST_PATH` pointing at the asar-**unpacked** renderer.

### Native binaries must be unpacked from asar

A Mach-O binary cannot be `dlopen`ed/executed from inside `app.asar`. So `electron-builder.yml` `asarUnpack`s:

- `better-sqlite3` and `node-pty` (native `.node` addons),
- `dist/renderer/**` (`express.static` can't range-read from inside asar),
- `@anthropic-ai/claude-agent-sdk-darwin-arm64/**` (the `claude` executable — see §3),
- `core-extensions/**` (staged into `DORK_HOME` via `fs.cp`).

### Native ABI rebuild happens at packaging time only

`better-sqlite3`/`node-pty` are compiled for **system Node** in the pnpm store (so dev + vitest work). Packaging needs them compiled for **Electron's** ABI. That rebuild:

- runs in the `pack`/`dist` scripts and the release workflow — **never** in a plain `pnpm build`. Putting it in `build` flips the store-shared binary to Electron's ABI and **breaks plain-Node vitest across the whole monorepo** (mesh/relay/site/client workers get SIGKILLed). Recover with `pnpm rebuild better-sqlite3` from the repo root.
- is done by `scripts/rebuild-natives.ts` calling `@electron/rebuild` **directly**. `electron-builder`'s own `npmRebuild` is disabled (`npmRebuild: false`) because it was observed producing a `better-sqlite3` that passed size/hash checks yet failed to `dlopen` with a misleading `NODE_MODULE_VERSION` error.

## 3. Bundling Claude Code

The default (and only bundled) runtime is claude-code. The Agent SDK ships the actual `claude` executable as a **per-platform optional dependency** (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`), not inside the main SDK package. To make it available in the packaged app:

1. `apps/desktop/package.json` declares `@anthropic-ai/claude-agent-sdk-darwin-arm64` as an os/cpu-guarded `optionalDependency` (so pnpm links it at the desktop top-level and electron-builder collects it). **Keep it version-locked to `@anthropic-ai/claude-agent-sdk`** — a lone SDK bump silently ships a skewed binary.
2. `electron-builder.yml` `asarUnpack`s it (native binary → real file on disk).
3. `src/main/server-process.ts` resolves the unpacked path in packaged mode and passes it to the server via `DORKOS_CLAUDE_CLI_PATH`; `sdk-utils.ts` honors that env override first, then falls back to the SDK's own bundled→PATH resolution (dev + npm CLI are unchanged — the env var is unset there).

This adds ~213 MB to the DMG (the binary itself). That is inherent to "runs Claude Code out of the box"; the arch-guard keeps it to the one target arch.

## 4. Runtime resilience (optional runtimes)

Only claude-code is bundled. Codex/OpenCode are config-gated (`runtimes.codex.enabled` etc.) and their SDK constructors **throw synchronously** when their CLI binary isn't present — the norm on a desktop install. `apps/server/src/index.ts` wraps each optional runtime's construct-through-register in `registerOptionalRuntime` (in `runtime-registry.ts`), which logs a warning and continues. A missing optional-runtime CLI must **never** take down the server; if you add a runtime, route it through the same helper.

## 5. Running & testing locally

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

**The desktop build rides the unified product release.** There is no separate desktop tag scheme — the `.github/workflows/desktop-release.yml` workflow triggers on the `v*` product tags that `/system:release` creates. When that command bumps `VERSION` (and `apps/desktop/package.json` alongside it), tags `vX.Y.Z`, and pushes, the workflow builds the macOS app and **attaches** the `.dmg` + `.zip` + `latest-mac.yml` to the GitHub Release the command already created. It does not create its own release or rewrite the notes. To release the desktop app you just run `/system:release` — do **not** push a standalone tag. (For a manual/verification build without publishing, use the workflow's `workflow_dispatch` with `dry_run`.)

Because the desktop build runs as a **separate workflow** from the release that `/system:release` cuts, a build or notarization failure can never block or unwind the product release — the release and its notes exist the moment the tag is pushed; the macOS assets attach later (or not, on failure). Fail-soft by construction. First-ever notarization can take ~30–65 min, so the DMG typically appears on the release minutes-to-an-hour after the CLI release is live; `dorkos.ai/download/mac` starts resolving to it once it attaches.

Signing + notarization are **CI-driven**, gated on the `APPLE_DEVELOPER_CONFIGURED` repo variable in the same workflow. When configured, a build signs with the Developer ID cert (from `CSC_LINK`/`CSC_KEY_PASSWORD`), notarizes with Apple (`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`), and staples the ticket.

Gotchas worth knowing (details vary by machine; the setup itself lives with the maintainer's Apple account):

- **Building a `.p12` with OpenSSL 3.x needs `-legacy`**, or macOS `security import` fails with "MAC verification failed (wrong password?)".
- **First-ever notarization from a new signing identity takes ~30–65 min** ("In Progress"); subsequent ones are minutes. There is no web dashboard — use `xcrun notarytool history|log`. Notarization is an automated malware scan (24/7, weekends included), **not** App Store review.
- **The auto-update `.zip` must be published alongside the `.dmg`** — Squirrel.Mac (electron-updater) can only install updates from the zip; a dmg-only release 404s every update check.
- **App Store is deliberately not a target.** The app spawns shells and agent CLIs and writes across the filesystem — none of which fits the App Sandbox. It ships as a Developer-ID-signed, notarized direct download (like VS Code, Docker Desktop, iTerm). See the maintainer's notes / DOR-230 for the rationale.

Verify a packaged build actually launches and runs a session (§6) before treating a release as good — static checks and unit tests pass long before the packaged runtime is exercised.
