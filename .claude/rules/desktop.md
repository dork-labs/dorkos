---
paths: 'apps/desktop/**'
---

# Desktop App Rules

The Electron desktop app (`apps/desktop`) is a thin shell around the same server + React client the CLI cockpit runs. Full reference: `contributing/desktop-app-development.md`. The load-bearing facts:

## Packaging model

- The main process spawns the Express server as a child (UtilityProcess in prod, `child_process.fork` via tsx in dev). The server bundle is built by `scripts/build-server.ts` (esbuild) into `dist/server/server-entry.mjs` — **it is NOT produced by `electron-vite build` alone**; the desktop `build` script runs both.
- In production the window loads `http://localhost:<serverPort>` (the bundled server serves the SPA), **not** `file://` — this avoids the `Origin: null` CORS dead-end. See ADR `260712-005315`.
- Native modules (`better-sqlite3`, `node-pty`) and the Claude Code binary (`@anthropic-ai/claude-agent-sdk-darwin-arm64`) must be `asarUnpack`ed — a Mach-O binary cannot execute from inside `app.asar`.
- Native modules are rebuilt for Electron's ABI at **packaging time only** (`pack`/`dist` scripts + the release workflow), never in plain `pnpm build` — that rebuild poisons the pnpm-store-shared binary for plain-Node vitest across the monorepo (recover with `pnpm rebuild better-sqlite3`).
- `electron-builder`'s own `npmRebuild` is disabled (it produced broken binaries); `scripts/rebuild-natives.ts` calls `@electron/rebuild` directly instead.

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

Signing/notarization is CI-driven (`.github/workflows/desktop-release.yml`, `APPLE_DEVELOPER_CONFIGURED` path). Credentials, the `-legacy` p12 quirk, the ~65-min first-notarization delay, and the recovery steps are all in `contributing/desktop-app-development.md` §Signing.
