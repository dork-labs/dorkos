---
title: 'Electron Desktop App in a Turborepo Monorepo: Architecture, Tooling, and Distribution'
date: 2026-03-24
type: external-best-practices
status: active
tags:
  [
    electron,
    vite,
    turborepo,
    pnpm,
    monorepo,
    native-modules,
    better-sqlite3,
    ipc,
    auto-update,
    macos,
    distribution,
  ]
searches_performed: 14
sources_count: 32
---

## Research Summary

electron-vite is the clear leading build tool for Electron+Vite projects in 2026, with a purpose-built three-process architecture (main/preload/renderer) and first-class HMR. For DorkOS, the key architectural question is how to host the existing Express server: the modern best practice is Electron's `UtilityProcess` API, which runs Express in an isolated Node.js child with full bidirectional messaging. better-sqlite3 requires a rebuild step against Electron's Node.js headers via `@electron/rebuild`, and ASAR unpacking for the `.node` binary. electron-builder is the recommended packaging and distribution tool (10x the weekly downloads of electron-forge, mature auto-update support via `electron-updater`, and first-class macOS universal binary + notarization support).

---

## Key Findings

1. **electron-vite is the right build tool**: Purpose-built for Vite+Electron, handles three Vite configs (main/preload/renderer) in a single `electron.vite.config.ts`, has HMR for renderer and hot restart for main/preload, and actively maintained with React scaffolding templates.

2. **UtilityProcess is the modern pattern for an embedded Express server**: `utilityProcess.fork()` spawns Express in a dedicated Node.js child process (not a fork of Electron's main process), preventing the UI thread from blocking. Communication uses `MessageChannelMain`, or alternatively a TCP localhost server. This directly parallels DorkOS's `DirectTransport` pattern from the Obsidian plugin.

3. **better-sqlite3 requires a two-step native module fix**: Run `@electron/rebuild` against Electron's headers, then unpack the `.node` binary from ASAR. In a pnpm monorepo, scope the rebuild to the correct workspace.

4. **electron-builder beats electron-forge for this use case**: More downloads (1.1M/week vs 2k), superior auto-update via `electron-updater`, mature universal binary support (`arch: "universal"`), and direct notarization integration. electron-forge has nicer DX but its Vite support is still experimental.

5. **Turborepo integration is straightforward**: The Electron app goes in `apps/desktop/`, imports from `packages/shared` and `packages/db` via workspace aliases, and Turborepo's standard `build` pipeline covers it. Dev workflow requires a custom orchestration script to launch `electron-vite dev` after shared packages are built.

6. **macOS distribution requires code signing + notarization**: As of macOS 10.15+, notarization is mandatory for apps distributed outside the App Store. A single universal DMG (merging x64 and arm64 builds) plus Homebrew Cask is the target distribution model.

---

## Detailed Analysis

### 1. Electron + Vite Integration

#### electron-vite (Recommended)

electron-vite is a purpose-built Vite plugin system that manages all three Electron entry points from a single config file. It requires Node.js 20.19+ or 22.12+ and Vite 5.0+.

**Project structure:**

```
apps/desktop/
├── electron.vite.config.ts   # unified config for main/preload/renderer
├── src/
│   ├── main/
│   │   └── index.ts          # Electron main process
│   ├── preload/
│   │   └── index.ts          # contextBridge preload
│   └── renderer/
│       ├── index.html
│       └── src/              # React app (same as apps/client)
└── out/                      # build output
```

Config structure:

```ts
// electron.vite.config.ts
import { defineConfig } from 'electron-vite';
export default defineConfig({
  main: {
    /* vite config for main process */
  },
  preload: {
    /* vite config for preload */
  },
  renderer: {
    /* vite config for renderer (React) */
  },
});
```

**HMR behavior:**

- Renderer: full Vite HMR (same as browser dev)
- Main + Preload: restart-based hot reload triggered on file change

**Key advantage for DorkOS**: The renderer Vite config can reference `packages/shared` and `packages/db` workspace packages with the same path aliases already defined in `apps/client`.

#### Electron Forge with Vite Plugin

Electron Forge is the official Electron-blessed packaging + build tool. Its Vite support (`@electron-forge/plugin-vite`) is still marked experimental as of Forge v7.5.0. The DX is more hand-held but less flexible. Not recommended for an existing Vite-first codebase.

**Recommendation: electron-vite for build tooling, electron-builder for packaging/distribution.**

---

### 2. Native Module Handling (better-sqlite3)

better-sqlite3 is a native C++ addon. When Electron loads it, Node's `NODE_MODULE_VERSION` must match Electron's bundled Node version — not the host system Node.

#### The Rebuild Step

`@electron/rebuild` is the official tool. It:

1. Detects the installed Electron version from `devDependencies`
2. Downloads C++ headers for that Electron version
3. Runs `node-gyp` with `--dist-url` pointing to Electron's asset repository and `--target` set to the Electron version

**In a pnpm monorepo, scope the rebuild to the desktop app's workspace:**

```json
// apps/desktop/package.json
{
  "scripts": {
    "postinstall": "electron-rebuild -f -w better-sqlite3"
  }
}
```

The `-w` flag prevents accidental rebuilds of native modules in other workspace packages.

#### ASAR Unpacking

better-sqlite3 loads a `.node` binary file at runtime. Native binaries cannot execute from inside a compressed ASAR archive — they must exist as real filesystem paths.

electron-builder configuration:

```json
{
  "build": {
    "asarUnpack": ["**/node_modules/better-sqlite3/**"]
  }
}
```

#### Where better-sqlite3 Should Live

Since DorkOS already has `packages/db` with `better-sqlite3`, the desktop app imports from there. The rebuild step in `apps/desktop/postinstall` will still find and rebuild it because `@electron/rebuild` traverses the full dependency tree.

**Alternative to consider**: For the desktop app, replacing better-sqlite3 with `sql.js` or Drizzle's Bun SQLite would eliminate the native rebuild complexity. However, since `packages/db` already uses better-sqlite3 for the server, it is cleaner to keep them consistent and handle the rebuild.

---

### 3. IPC Architecture Patterns

#### Context Isolation and contextBridge (Mandatory)

Since Electron 12, context isolation is enabled by default. The renderer process runs in a sandboxed browser context with no access to Node.js APIs. All communication must go through the preload script using `contextBridge.exposeInMainWorld`.

**Do not expose the full `ipcRenderer`** — that gives renderer code the ability to send any message to the main process. Instead, expose typed wrappers:

```ts
// preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  sendMessage: (sessionId: string, text: string) =>
    ipcRenderer.invoke('session:send', { sessionId, text }),
  onStreamEvent: (callback: (event: StreamEvent) => void) =>
    ipcRenderer.on('stream:event', (_, event) => callback(event)),
});
```

```ts
// renderer/src/preload.d.ts
interface Window {
  electronAPI: {
    sendMessage(sessionId: string, text: string): Promise<void>;
    onStreamEvent(callback: (event: StreamEvent) => void): void;
  };
}
```

#### Running the Express Server: UtilityProcess (Recommended)

The modern best practice (Electron 22+) is to run the Express server in a `UtilityProcess`:

```ts
// main/index.ts
import { utilityProcess } from 'electron';
import path from 'path';

const serverProcess = utilityProcess.fork(path.join(__dirname, 'server-entry.js'), [], {
  serviceName: 'DorkOS Server',
});

// Two-way messaging via MessageChannelMain
const { port1, port2 } = new MessageChannelMain();
serverProcess.postMessage({ type: 'port' }, [port2]);
```

**Why UtilityProcess over alternatives:**

- `child_process.fork` is the legacy approach; UtilityProcess is Electron's native equivalent, with better lifecycle management and no "main process IPC saturation" risk
- Running Express directly in the main process blocks the UI on heavy work (identified as an anti-pattern)
- Worker threads (`worker_threads`) are available but UtilityProcess is preferred for full Node.js API access and crash isolation

#### IPC vs Localhost HTTP

Benchmarks show Electron IPC latency at ~0.08ms vs >1ms for localhost HTTP. However, there is an important DorkOS-specific consideration:

**The existing Transport abstraction already solves this elegantly.**

DorkOS has `DirectTransport` (used by the Obsidian plugin) for in-process communication and `HttpTransport` for the web client. For the Electron app:

1. **Option A — Keep HTTP Transport**: Run Express in UtilityProcess, renderer talks to `http://localhost:PORT` via the existing `HttpTransport`. Zero new code. Adds ~1-2ms per request.

2. **Option B — ElectronTransport via IPC**: Implement a third `Transport` adapter that routes calls through `contextBridge` → `ipcMain` → UtilityProcess. Type-safe, ~0.08ms latency, more code.

**Recommendation: Start with Option A (HttpTransport over localhost).** The latency difference is imperceptible for human-facing UI. The Obsidian plugin's `DirectTransport` already demonstrates that new transports can be added when the performance case arises. An `ElectronIPCTransport` can be a follow-up optimization.

#### Type-Safe IPC Libraries

For teams wanting full type safety from renderer to main at the IPC boundary: `electron-typescript-ipc` provides compile-time verification that methods exist and match expected signatures.

---

### 4. Auto-Update Strategy

#### electron-updater (Recommended)

Install as a regular dependency (not devDependency):

```
pnpm add electron-updater --filter @dorkos/desktop
```

Supports: GitHub Releases, Amazon S3, DigitalOcean Spaces, Keygen, and generic HTTPS servers.

**GitHub Releases setup:**

```ts
import { autoUpdater } from 'electron-updater';

autoUpdater.checkForUpdatesAndNotify();
// Or for staged rollout:
autoUpdater.checkForUpdates().then((result) => {
  if (result?.downloadPromise) {
    result.downloadPromise.then(() => autoUpdater.quitAndInstall());
  }
});
```

electron-builder auto-generates `latest.yml` / `latest-mac.yml` during packaging and uploads it alongside the DMG to GitHub Releases.

**Advantages over Squirrel (electron-forge's default):**

- Works on Linux (AppImage, DEB)
- Code signature validation on Windows
- Download progress events
- Staged rollout support
- No Squirrel headless process spawning quirks on macOS

#### macOS Auto-Update Requirements

Code signing is mandatory for auto-updates on macOS. The auto-update flow:

1. App polls GitHub Releases for `latest-mac.yml`
2. Downloads new DMG/ZIP
3. Verifies code signature
4. Applies update

Without signing, step 3 fails. There is no workaround.

#### Update Hosting

| Provider        | Cost               | Setup Complexity | Recommendation                      |
| --------------- | ------------------ | ---------------- | ----------------------------------- |
| GitHub Releases | Free               | Low              | Use for DorkOS initially            |
| S3/R2           | ~$0 for small apps | Medium           | Good for private or staged rollouts |
| Keygen          | $29+/mo            | Low              | Enterprise feature management       |

---

### 5. Monorepo Integration (Turborepo + pnpm)

#### Package Structure

Add the Electron app as a new app in the existing monorepo:

```
apps/
  desktop/              # @dorkos/desktop — NEW
    package.json
    electron.vite.config.ts
    src/
      main/             # Electron main process
      preload/          # contextBridge preload
      renderer/         # Re-uses apps/client as the renderer (see below)
      server-entry.ts   # Entry point for Express in UtilityProcess
    build/
      entitlements.mac.plist
      icon.icns
```

#### Renderer Strategy: Fork vs Symlink vs Re-export

The renderer is a React app. DorkOS already has `apps/client`. Three options:

1. **Duplicate renderer in `apps/desktop/src/renderer/`**: Most explicit, allows desktop-specific UI without polluting the web client. Downside: code duplication.

2. **Reference `apps/client` directly in electron-vite config**: Point the renderer's `root` to `apps/client/src`. Cleanest for identical UI. Risk: the client may have web-only deps that pollute the desktop build.

3. **Share via packages**: Extract shared UI into `packages/ui`, let both `apps/client` and `apps/desktop` import from it. The cleanest long-term but requires extracting shared UI first.

**Recommendation: Start with Option 2** (point renderer at `apps/client`). When desktop-specific UI diverges, extract to Option 3.

#### turbo.json Pipeline

```json
// turbo.json (additions)
{
  "tasks": {
    "desktop#build": {
      "dependsOn": ["^build", "shared#build", "db#build"],
      "outputs": ["apps/desktop/out/**"]
    },
    "desktop#dev": {
      "dependsOn": ["shared#build"],
      "cache": false,
      "persistent": true
    }
  }
}
```

#### Dev Workflow

electron-vite provides a `dev` command that starts all three process watchers simultaneously. In the monorepo, shared packages need to be built first:

```json
// apps/desktop/package.json
{
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build && electron-builder",
    "postinstall": "electron-rebuild -f -w better-sqlite3"
  }
}
```

Root dev command:

```bash
pnpm --filter @dorkos/shared build && pnpm --filter @dorkos/desktop dev
```

Or use Turborepo's `persistent` task support with `dependsOn`.

#### pnpm Workspace Declaration

```yaml
# pnpm-workspace.yaml (already exists, no change needed)
packages:
  - 'apps/*'
  - 'packages/*'
```

```json
// apps/desktop/package.json
{
  "dependencies": {
    "@dorkos/shared": "workspace:*",
    "@dorkos/db": "workspace:*",
    "better-sqlite3": "...",
    "electron-updater": "..."
  },
  "devDependencies": {
    "electron": "...",
    "electron-vite": "...",
    "@electron/rebuild": "...",
    "electron-builder": "..."
  }
}
```

---

### 6. Distribution

#### Target Formats

For macOS-first distribution, the targets are:

- **DMG**: Standard macOS installer, what users expect
- **ZIP**: Required for auto-updates (`electron-updater` uses the ZIP for delta updates on macOS)

electron-builder produces both by default when `target: "default"` is set on macOS.

#### Universal Binary (arm64 + x64)

A universal binary contains both architectures in a single download. electron-builder supports this via:

```json
{
  "mac": {
    "target": [{ "target": "dmg", "arch": ["universal"] }]
  }
}
```

Under the hood, this uses `@electron/universal` to merge two architecture-specific builds. Key configuration:

- `mergeASARs: true` (default): Merges app.asar files for both architectures
- `singleArchFiles`: Glob patterns for architecture-specific native binaries (important for `better-sqlite3.node`)

**Native module caveat with universal builds**: better-sqlite3's `.node` binary is architecture-specific. When building a universal binary, electron-builder needs both `arm64` and `x64` builds of the `.node` file to merge. The recommended approach is to:

1. Build on an Apple Silicon Mac (supports building both architectures)
2. Or use CI with separate build steps and let `@electron/universal` merge them

#### Code Signing + Notarization

electron-builder configuration:

```json
{
  "mac": {
    "hardenedRuntime": true,
    "entitlements": "build/entitlements.mac.plist",
    "entitlementsInherit": "build/entitlements.mac.plist",
    "notarize": true
  }
}
```

Environment variables (set in CI, never hardcoded):

- `APPLE_API_KEY` (path to `.p8` file) + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` — preferred (App Store Connect API key, no 2FA complications)
- Or: `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`

**Entitlements plist** (`build/entitlements.mac.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ...>
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.network.client</key><true/>
  <key>com.apple.security.network.server</key><true/>
  <key>com.apple.security.files.user-selected.read-write</key><true/>
</dict>
</plist>
```

Note: `com.apple.security.cs.allow-jit` is required for Electron 20+ on arm64 (V8 JIT).

#### Homebrew Cask

After publishing the first signed+notarized release to GitHub Releases, submit a Homebrew Cask formula:

```ruby
# Formula/dorkos.rb (in a homebrew-tap repo)
cask "dorkos" do
  version "1.0.0"
  sha256 "abc123..."

  url "https://github.com/dorkos/dorkos/releases/download/v#{version}/DorkOS-#{version}.dmg"
  name "DorkOS"
  desc "The operating system for autonomous AI agents"
  homepage "https://dorkos.dev"

  app "DorkOS.app"
end
```

Host as `github.com/dorkos/homebrew-dorkos`, installable via:

```bash
brew install --cask dorkos/dorkos/dorkos
```

Submission to `homebrew-cask` (the main tap) is optional but worthwhile once the app is public.

#### CI/CD for Distribution

GitHub Actions workflow:

```yaml
jobs:
  build-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install
      - run: pnpm --filter @dorkos/desktop build
    env:
      APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
      APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
      APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Architecture Recommendation for DorkOS

Given the existing architecture, the recommended Electron integration path:

```
apps/desktop/
  src/
    main/index.ts          # Electron lifecycle, creates BrowserWindow, forks UtilityProcess
    preload/index.ts       # contextBridge — exposes minimal API surface to renderer
    server-entry.ts        # Thin wrapper: imports apps/server entry, starts Express
    renderer/              # Points at apps/client/src (via electron.vite.config.ts root)
```

**Transport pattern:**

- Desktop uses `HttpTransport` pointed at `http://localhost:${PORT}`
- Express runs in `UtilityProcess` — main process passes a random free port to it via `postMessage`
- Renderer is told the port via preload contextBridge before React initializes

This means **zero changes to `apps/server` or `apps/client`** for the first pass. The desktop app is purely an Electron wrapper that:

1. Spawns the server
2. Opens a window pointing at the local server
3. Handles app lifecycle (quit, tray icon, auto-update)

The existing `DirectTransport` pattern from the Obsidian plugin could be extended to an `ElectronIPCTransport` in a later iteration if latency becomes a concern.

---

## Pros/Cons Summary

### Build Tool

|                | electron-vite                    | electron-forge + Vite |
| -------------- | -------------------------------- | --------------------- |
| Vite 6 support | Yes                              | Experimental (v7.5+)  |
| React template | Yes                              | Yes                   |
| HMR            | Full (renderer) + restart (main) | Same                  |
| Monorepo       | Manual config, works well        | Manual config         |
| **Verdict**    | **Use this**                     | Skip                  |

### Packaging Tool

|                  | electron-builder             | electron-forge          |
| ---------------- | ---------------------------- | ----------------------- |
| Weekly downloads | 1.1M                         | 2K                      |
| Auto-update      | electron-updater (excellent) | Squirrel (macOS quirks) |
| Universal macOS  | Yes                          | Yes                     |
| Notarization     | Built-in                     | Built-in                |
| Config           | JSON/YAML in package.json    | JS config object        |
| **Verdict**      | **Use this**                 | Skip                    |

### Server Architecture

|                 | Main process (blocking) | UtilityProcess     | child_process.fork | Localhost HTTP only |
| --------------- | ----------------------- | ------------------ | ------------------ | ------------------- |
| Freezes UI      | Yes                     | No                 | No                 | No                  |
| Crash isolation | No                      | Yes                | Partial            | N/A                 |
| IPC latency     | 0.08ms                  | Via MessageChannel | Via IPC            | >1ms                |
| Modern API      | No                      | Yes (Electron 22+) | Legacy             | N/A                 |
| **Verdict**     | Never                   | Best               | Legacy             | Acceptable          |

---

## Research Gaps & Limitations

- electron-vite's exact Vite 6 compatibility status was not confirmed (docs show "Vite 5.0+" as minimum; Vite 6 likely works but verify on project init)
- The `@electron/universal` merge behavior with better-sqlite3's dual-arch `.node` files requires hands-on testing — CI matrix approach may be needed
- Code signing on CI with Apple API keys vs App Store Connect certificate rotation procedures were not deeply researched
- Linux distribution (`.deb`, AppImage) was not researched — out of scope for macOS-first
- Windows (NSIS installer) distribution was not researched

## Contradictions & Disputes

- Some sources recommend running Express directly in the main process for simplicity; this is an anti-pattern that risks blocking the UI thread and should not be followed for DorkOS
- electron-forge's Vite plugin docs say it's "experimental" but individual developer blog posts treat it as production-ready; trust the official designation

---

## Search Methodology

- Searches performed: 14
- Most productive terms: "electron-vite guide", "better-sqlite3 Electron rebuild pnpm monorepo", "Electron UtilityProcess Express 2025", "electron-builder vs electron-forge 2025", "electron macOS universal binary arm64"
- Primary sources: electron-vite.org, electronjs.org, electron.build, GitHub repositories (buqiyuan/electron-vite-monorepo, jlongster/electron-with-server-example, vickp/electron-vite-react-monorepo), LogRocket Blog, npm trends

---

## Sources & Evidence

- [electron-vite Getting Started](https://electron-vite.org/guide/) — project structure, unified config
- [electron-vite Development Guide](https://electron-vite.org/guide/dev) — HMR, dev server
- [electron-vite homepage](https://electron-vite.org/) — feature overview
- [Electron Forge Vite Plugin](https://www.electronforge.io/templates/vite) — experimental status
- [Electron IPC Tutorial](https://www.electronjs.org/docs/latest/tutorial/ipc) — invoke API, patterns
- [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) — security model
- [Electron contextBridge API](https://www.electronjs.org/docs/latest/api/context-bridge) — exposeInMainWorld
- [Electron utilityProcess API](https://www.electronjs.org/docs/latest/api/utility-process) — forking server processes
- [electron-builder Auto Update](https://www.electron.build/auto-update.html) — providers, macOS requirements
- [electron-builder macOS targets](https://www.electron.build/mac.html) — DMG, universal binary, notarization
- [electron/rebuild unhandled error issue](https://github.com/electron/rebuild/issues/1179) — better-sqlite3 rebuild in Electron 35
- [Fixing node-gyp rebuild errors with better-sqlite3](https://coldfusion-example.blogspot.com/2026/01/fixing-node-gyp-rebuild-errors-with.html) — postinstall patterns
- [Advanced Electron.js Architecture — LogRocket](https://blog.logrocket.com/advanced-electron-js-architecture/) — UtilityProcess, IPC patterns
- [electron-with-server-example](https://github.com/jlongster/electron-with-server-example) — socket-based IPC pattern
- [electron-vite-monorepo (Turborepo)](https://github.com/buqiyuan/electron-vite-monorepo) — monorepo structure reference
- [electron-vite-react-monorepo](https://github.com/vickp/electron-vite-react-monorepo) — React + Turborepo pattern
- [electron-typescript-ipc](https://www.npmjs.com/package/electron-typescript-ipc) — type-safe IPC
- [Electron Apple Silicon Support](https://www.electronjs.org/blog/apple-silicon/) — universal binary timeline
- [electron/universal](https://github.com/electron/universal) — merge tool for universal macOS builds
- [electron-builder vs electron-forge npm trends](https://npmtrends.com/electron-builder-vs-electron-forge-vs-electron-packager) — download stats
- [Why Electron Forge?](https://www.electronforge.io/core-concepts/why-electron-forge) — Forge's self-description
- [macOS Code Signing — electron-builder](https://www.electron.build/code-signing-mac.html) — signing config
- [Sign and notarize GitHub Actions example](https://github.com/omkarcloud/macos-code-signing-example) — CI patterns
- [Homebrew Cask for private GitHub releases](https://andre.arko.net/2023/11/24/homebrew-cask-formula-for-private-github-repo-releases/) — cask formula setup
- [IPC Benchmark — DEV Community](https://dev.to/taw/electron-adventures-episode-20-ipc-benchmark-2b2d) — 0.08ms IPC latency
