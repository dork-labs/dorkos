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

That bundle carries two gates, both of which fail the build (DOR-536):

- **No esbuild warnings.** esbuild reports this app's most expensive failure class — a bundle that builds green and dies only in a packaged install — as _warnings_: an unresolvable dynamic `require`, `import.meta` in the wrong output format, an external that never resolves. `ALLOWED_WARNING_TEXTS` in `build-server.ts` is the allowlist and is empty; adding to it requires quoting the warning and saying why it's safe.
- **Every runtime specifier resolves _and ships_.** After a successful build the script `node --check`s the emitted `.mjs`, resolves every external the metafile says it left in the output (plus the two `require`-routed natives, which esbuild can't see) from the bundle's own directory, and then checks each one's package is a declared `dependencies`/`optionalDependencies` entry. Both halves are needed: at build time `dist/server/` sits inside the source tree, so resolution also reaches devDependencies and the repo root — a devDependency would resolve happily here and be absent from the packaged app, since electron-builder packs only the production tree.

The same warning gate now guards `packages/cli/scripts/build.ts` — same module graph, same external list, and it's the launch-critical surface. Keep the two copies in step.

Both gates stop at resolution and never _evaluate_ the bundle — evaluating it would boot the server (port + `~/.dork`) and `dlopen` the native modules, which after a `rebuild-natives.ts` run would wedge the build under system Node. The packaged runtime is exercised for real by `scripts/smoke-packaged.ts` (§5) instead.

### The window loads from localhost, not file://

In production the main window loads `http://localhost:<serverPort>` — the bundled server serves the built SPA via `express.static`. It does **not** use `loadFile('…/index.html')`. Reason: a `file://` page sends `Origin: null`, which the server's CORS allowlist rejects, so a `file://` renderer can't call its own API. Serving both SPA and API from one localhost origin makes every request same-origin (and cookie auth works exactly as in the web cockpit). See **ADR `260712-005315`**. The main process passes the server child `CLIENT_DIST_PATH` pointing at the asar-**unpacked** renderer.

### Native binaries must be unpacked from asar

A Mach-O binary cannot be `dlopen`ed/executed from inside `app.asar`. So `electron-builder.yml` `asarUnpack`s:

- `better-sqlite3` and `node-pty` (native `.node` addons),
- `dist/renderer/**` (`express.static` can't range-read from inside asar),
- `@anthropic-ai/claude-agent-sdk-darwin-arm64/**` (the `claude` executable — see §3),
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

Verify a packaged build actually launches and runs a session (§6) before treating a release as good — static checks and unit tests pass long before the packaged runtime is exercised. `desktop-smoke.yml` (§5) covers the "does it boot and serve" half automatically; running a real session in the packaged app is still a human step.
