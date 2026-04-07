---
slug: electron-desktop-app
number: 181
created: 2026-03-24
status: draft
---

# Electron Desktop App — Native macOS Distribution for DorkOS

**Status:** Draft
**Authors:** Claude Code, 2026-03-24
**Ideation:** `specs/electron-desktop-app/01-ideation.md`
**Research:** `research/20260324_electron_desktop_app_monorepo.md`

---

## Overview

Add `apps/desktop/` to the DorkOS monorepo — an Electron desktop app that provides the full DorkOS experience as a native macOS application. The Express server runs in an Electron UtilityProcess on a free localhost port; the renderer loads the existing React client with HttpTransport pointed at that port. Zero changes to `apps/client/`, `apps/server/`, or any shared package.

This is the fourth distribution channel alongside CLI (npm), web (browser), and Obsidian plugin — all sharing the same codebase through the Transport abstraction.

## Background / Problem Statement

DorkOS currently requires either a CLI install (`npm i -g dorkos`) or running the dev server. Both require a terminal. A native desktop app provides:

- **One-click launch** — no terminal, no `dorkos start`, no port management
- **Always-on presence** — lives in the dock, launches at login
- **Auto-updates** — silent background updates, no `npm update`
- **Native feel** — macOS menu bar, window management, Cmd+Q, system notifications
- **Discoverability** — Homebrew Cask install, DMG download from website

The primary persona (Kai) runs 10-20 agent sessions per week. A desktop app eliminates friction between "thinking about running an agent" and "having DorkOS open."

## Goals

- Ship a signed, notarized macOS DMG that installs DorkOS.app
- Full DorkOS experience: dashboard, agents page, session page (AppShell with TanStack Router)
- Shared `~/.dork/` data directory — sessions created in Electron are visible in CLI and vice versa
- Auto-updates via GitHub Releases
- Server crash isolation — UtilityProcess crash shows error UI, doesn't kill the app
- Window state persistence (position, size) across restarts
- Native macOS menu bar with standard Edit/View/Window/Help menus
- Turborepo integration — `turbo build` includes the desktop app

## Non-Goals

- Windows/Linux support (follow-up spec)
- Mac App Store distribution (sandbox blocks subprocess spawning)
- Custom ElectronIPCTransport (HTTP localhost is sufficient; optimize later if profiling warrants)
- Tray-only mode (no window)
- Mobile apps
- Embedded/compact mode (Obsidian-style single panel)

## Technical Dependencies

| Dependency          | Version | Purpose                                         |
| ------------------- | ------- | ----------------------------------------------- |
| `electron`          | ^33.x   | Desktop runtime                                 |
| `electron-vite`     | ^3.x    | Vite-based build for main/preload/renderer      |
| `electron-builder`  | ^26.x   | Packaging, signing, notarization, DMG           |
| `electron-updater`  | ^6.x    | Auto-update via GitHub Releases                 |
| `@electron/rebuild` | ^3.x    | Rebuild native modules against Electron headers |

All existing workspace packages (`@dorkos/shared`, `@dorkos/server`, `@dorkos/client`, `@dorkos/db`) are reused as-is.

## Detailed Design

### Architecture

```
┌─────────────────────────────────────────────────┐
│                  Electron Main Process           │
│                                                  │
│  ┌──────────────┐  ┌─────────────────────────┐  │
│  │ Window       │  │ UtilityProcess          │  │
│  │ Manager      │  │                         │  │
│  │ (bounds,     │  │  server-entry.ts        │  │
│  │  lifecycle)  │  │  ┌───────────────────┐  │  │
│  └──────────────┘  │  │ @dorkos/server    │  │  │
│                     │  │ Express on :PORT  │  │  │
│  ┌──────────────┐  │  │ SQLite ~/.dork/   │  │  │
│  │ Auto-Updater │  │  └───────────────────┘  │  │
│  └──────────────┘  └─────────────────────────┘  │
│                              ▲                    │
│  ┌──────────────┐           │ IPC: port number   │
│  │ Menu Builder │           │                    │
│  └──────────────┘           │                    │
└─────────────────────────────┼────────────────────┘
                              │
         ┌────────────────────┼──────────────────┐
         │    Preload Script  │                  │
         │    contextBridge:  │                  │
         │    getServerPort() ▼                  │
         ├───────────────────────────────────────┤
         │           Renderer Process            │
         │                                       │
         │  HttpTransport(`localhost:${port}/api`)│
         │  ┌─────────────────────────────────┐  │
         │  │ @dorkos/client                  │  │
         │  │ AppShell + TanStack Router      │  │
         │  │ Dashboard / Agents / Sessions   │  │
         │  └─────────────────────────────────┘  │
         └───────────────────────────────────────┘
```

### Four Distribution Channels

| Channel      | Entry                              | Transport                        | Server                  | Output       |
| ------------ | ---------------------------------- | -------------------------------- | ----------------------- | ------------ |
| **CLI**      | `packages/cli/src/cli.ts`          | HttpTransport (localhost:4242)   | Bundled in dist/server/ | npm `dorkos` |
| **Web**      | `apps/client/src/main.tsx`         | HttpTransport (`/api`)           | External                | Static dist/ |
| **Obsidian** | `apps/obsidian-plugin/src/main.ts` | DirectTransport (in-process)     | Imported                | .zip         |
| **Desktop**  | `apps/desktop/src/main/index.ts`   | HttpTransport (localhost:{free}) | UtilityProcess          | Signed DMG   |

### File Structure

```
apps/desktop/
├── src/
│   ├── main/
│   │   ├── index.ts              # Electron app lifecycle
│   │   ├── window-manager.ts     # BrowserWindow create/restore, bounds persistence
│   │   ├── server-process.ts     # UtilityProcess spawn/monitor/restart
│   │   ├── menu.ts               # Native macOS menu bar
│   │   └── auto-updater.ts       # electron-updater integration
│   ├── preload/
│   │   └── index.ts              # contextBridge: exposes server port
│   └── server-entry.ts           # Thin shim: starts Express on assigned port
├── build/
│   ├── entitlements.mac.plist    # macOS entitlements
│   ├── icon.icns                 # App icon (1024x1024 source)
│   └── dmg-background.png        # DMG installer background (optional)
├── electron.vite.config.ts       # 3-in-1: main + preload + renderer
├── electron-builder.yml          # Packaging config
├── package.json
└── tsconfig.json
```

### Main Process (`src/main/index.ts`)

Orchestrates the app lifecycle:

```typescript
import { app, BrowserWindow } from 'electron';
import { createWindow, restoreWindowState } from './window-manager';
import { startServer, stopServer } from './server-process';
import { setupMenu } from './menu';
import { setupAutoUpdater } from './auto-updater';

let mainWindow: BrowserWindow | null = null;
let serverPort: number | null = null;

app.on('ready', async () => {
  // 1. Start Express in UtilityProcess
  serverPort = await startServer();

  // 2. Create window
  mainWindow = createWindow(serverPort);

  // 3. Setup native menu
  setupMenu(mainWindow);

  // 4. Check for updates (non-blocking)
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  // macOS: stay in dock until Cmd+Q
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await stopServer();
});

app.on('activate', () => {
  // macOS: re-create window when dock icon clicked
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
    mainWindow = createWindow(serverPort);
  }
});
```

### Server Process (`src/main/server-process.ts`)

Spawns Express in an isolated UtilityProcess:

```typescript
import { utilityProcess } from 'electron';
import { app } from 'electron';
import net from 'node:net';
import path from 'node:path';

/** Find a free port by binding to port 0 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

let child: Electron.UtilityProcess | null = null;

export async function startServer(): Promise<number> {
  const port = await getFreePort();
  const dorkHome = path.join(app.getPath('home'), '.dork');

  child = utilityProcess.fork(path.join(__dirname, '../server-entry.js'), [], {
    env: {
      ...process.env,
      DORKOS_PORT: String(port),
      DORK_HOME: dorkHome,
      NODE_ENV: 'production',
    },
  });

  // Wait for "ready" signal
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 15_000);
    child!.on('message', (msg: { type: string }) => {
      if (msg.type === 'ready') {
        clearTimeout(timeout);
        resolve();
      }
    });
    child!.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Server exited with code ${code}`));
    });
  });

  return port;
}

export async function stopServer(): Promise<void> {
  if (child) {
    child.postMessage({ type: 'shutdown' });
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child?.kill();
        resolve();
      }, 5_000);
      child!.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    child = null;
  }
}
```

### Server Entry (`src/server-entry.ts`)

Thin shim that imports the existing server and signals readiness:

```typescript
// This file runs inside the UtilityProcess
import { start } from '@dorkos/server';

async function main() {
  await start();
  // Signal to main process that server is ready
  process.parentPort?.postMessage({ type: 'ready' });

  // Listen for shutdown signal
  process.parentPort?.on('message', (event) => {
    if (event.data?.type === 'shutdown') {
      process.exit(0);
    }
  });
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
```

### Window Manager (`src/main/window-manager.ts`)

Manages BrowserWindow creation with state persistence:

```typescript
import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { app } from 'electron';

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

const STATE_FILE = join(app.getPath('userData'), 'window-state.json');

function loadWindowState(): WindowState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return { width: 1200, height: 800, isMaximized: false };
  }
}

function saveWindowState(win: BrowserWindow): void {
  const bounds = win.getBounds();
  const state: WindowState = {
    ...bounds,
    isMaximized: win.isMaximized(),
  };
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

export function createWindow(serverPort: number): BrowserWindow {
  const state = loadWindowState();

  const win = new BrowserWindow({
    ...state,
    minWidth: 800,
    minHeight: 600,
    title: 'DorkOS',
    titleBarStyle: 'hiddenInset', // Native macOS traffic lights
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required for preload to access Node APIs
    },
  });

  if (state.isMaximized) win.maximize();

  // Load the renderer pointing at the local server
  // In dev: electron-vite serves the renderer with HMR
  // In prod: load the built index.html
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // Persist window state on close
  win.on('close', () => saveWindowState(win));

  return win;
}
```

### Preload Script (`src/preload/index.ts`)

Exposes the server port to the renderer via contextBridge:

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getServerPort: (): Promise<number> => ipcRenderer.invoke('get-server-port'),
  getAppVersion: (): string => ipcRenderer.sendSync('get-app-version'),
  platform: process.platform,
});
```

### Renderer Entry

The renderer reuses `apps/client` directly. electron-vite's renderer config points `root` at `../../client/src`. The only difference from web: HttpTransport receives the port from the preload bridge instead of using `/api`.

In the client's `main.tsx`, a small check detects Electron:

```typescript
// Detect Electron environment and get server URL
function getApiBaseUrl(): string {
  if (window.electronAPI?.getServerPort) {
    // Running in Electron — server on localhost:{port}
    const port = window.electronAPI.getServerPort();
    return `http://localhost:${port}/api`;
  }
  // Web mode — proxy via Vite or relative path
  return '/api';
}

const transport = new HttpTransport(getApiBaseUrl());
```

**Note:** This is the only change to `apps/client/` — a 5-line check in `main.tsx`. All other client code is untouched.

### Type Declaration for Electron API

Add to `apps/client/src/vite-env.d.ts` (or a new `electron.d.ts`):

```typescript
interface ElectronAPI {
  getServerPort(): Promise<number>;
  getAppVersion(): string;
  platform: NodeJS.Platform;
}

interface Window {
  electronAPI?: ElectronAPI;
}
```

### electron-vite Config (`electron.vite.config.ts`)

```typescript
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        external: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
    },
  },
  renderer: {
    root: path.resolve(__dirname, '../client'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '../client/src'),
      },
    },
    build: {
      outDir: path.resolve(__dirname, 'dist/renderer'),
      rollupOptions: {
        input: path.resolve(__dirname, '../client/index.html'),
        external: ['@dorkos/shared/manifest'],
      },
    },
  },
});
```

### electron-builder Config (`electron-builder.yml`)

```yaml
appId: com.dorkos.desktop
productName: DorkOS
directories:
  output: release
  buildResources: build

mac:
  category: public.app-category.developer-tools
  target:
    - target: dmg
      arch:
        - universal
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  notarize: true
  icon: build/icon.icns

dmg:
  sign: false # DMG itself doesn't need signing, the .app inside does
  artifactName: DorkOS-${version}-${arch}.dmg

publish:
  provider: github
  owner: dorkos
  repo: core

asar: true
asarUnpack:
  - '**/node_modules/better-sqlite3/**'
  - '**/node_modules/@anthropic-ai/claude-agent-sdk/**'

extraResources:
  - from: '../server/node_modules/better-sqlite3'
    to: 'node_modules/better-sqlite3'

npmRebuild: true

afterSign: electron-builder-notarize
```

### macOS Entitlements (`build/entitlements.mac.plist`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.network.server</key>
  <true/>
  <key>com.apple.security.files.user-selected.read-write</key>
  <true/>
</dict>
</plist>
```

### Native Menu (`src/main/menu.ts`)

```typescript
import { app, Menu, shell, BrowserWindow } from 'electron';

export function setupMenu(mainWindow: BrowserWindow): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'DorkOS Documentation',
          click: () => shell.openExternal('https://dorkos.ai/docs'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
```

### Auto-Updater (`src/main/auto-updater.ts`)

```typescript
import { autoUpdater } from 'electron-updater';
import { dialog, BrowserWindow } from 'electron';
import log from 'electron-log';

export function setupAutoUpdater(): void {
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info.version);
  });

  autoUpdater.on('update-downloaded', (info) => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      dialog
        .showMessageBox(win, {
          type: 'info',
          title: 'Update Ready',
          message: `DorkOS ${info.version} is ready to install.`,
          detail: 'The update will be applied when you restart the app.',
          buttons: ['Restart Now', 'Later'],
        })
        .then(({ response }) => {
          if (response === 0) autoUpdater.quitAndInstall();
        });
    }
  });

  // Check for updates on launch (non-blocking)
  autoUpdater.checkForUpdatesAndNotify();
}
```

### Package Configuration (`package.json`)

```json
{
  "name": "@dorkos/desktop",
  "version": "0.1.0",
  "private": true,
  "main": "dist/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "pack": "electron-builder --dir",
    "dist": "electron-builder",
    "postinstall": "electron-rebuild -f -w better-sqlite3"
  },
  "dependencies": {
    "@dorkos/server": "workspace:*",
    "@dorkos/shared": "workspace:*",
    "@dorkos/db": "workspace:*",
    "electron-updater": "^6.3.0",
    "electron-log": "^5.2.0"
  },
  "devDependencies": {
    "@dorkos/client": "workspace:*",
    "electron": "^33.0.0",
    "electron-vite": "^3.0.0",
    "electron-builder": "^26.0.0",
    "@electron/rebuild": "^3.7.0",
    "@vitejs/plugin-react": "^4.3.0",
    "@tailwindcss/vite": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.0"
  }
}
```

### Turborepo Integration

Add to `turbo.json` tasks:

```json
{
  "desktop#build": {
    "dependsOn": ["^build"],
    "outputs": ["dist/**"],
    "env": ["ELECTRON_VERSION"]
  },
  "desktop#dev": {
    "dependsOn": ["^build"],
    "cache": false,
    "persistent": true
  },
  "desktop#dist": {
    "dependsOn": ["desktop#build"],
    "outputs": ["release/**"],
    "cache": false,
    "env": [
      "APPLE_API_KEY",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "GH_TOKEN"
    ]
  }
}
```

Also add `ELECTRON_VERSION` to `globalPassThroughEnv`.

### Server Crash Recovery

When the UtilityProcess exits unexpectedly, the main process shows an error overlay and offers restart:

```typescript
// In server-process.ts, after spawning:
child.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      dialog
        .showMessageBox(win, {
          type: 'error',
          title: 'Server Error',
          message: 'The DorkOS server stopped unexpectedly.',
          detail: `Exit code: ${code}. Your data is safe.`,
          buttons: ['Restart Server', 'Quit'],
        })
        .then(async ({ response }) => {
          if (response === 0) {
            serverPort = await startServer();
            win.loadURL(`http://localhost:${serverPort}`);
          } else {
            app.quit();
          }
        });
    }
  }
});
```

## User Experience

### First Launch

1. User downloads `DorkOS-1.0.0-universal.dmg` or runs `brew install --cask dorkos`
2. Opens DMG, drags DorkOS.app to Applications (standard macOS flow)
3. Launches DorkOS — Gatekeeper verifies notarization
4. Express server starts (splash/loading indicator while server initializes, ~2-3 seconds)
5. Full DorkOS UI loads — identical to web experience
6. If `~/.dork/` exists from CLI usage, all existing sessions and agents are immediately visible

### Ongoing Use

- App lives in dock. Click to open/focus
- Cmd+Q quits gracefully (server shuts down)
- Close window (Cmd+W) hides window but keeps app in dock (macOS convention)
- Updates download in background, prompt to restart when ready
- Running CLI simultaneously is safe — both point at the same `~/.dork/` data, different server instances on different ports

### CLI Coexistence

The desktop app and CLI can run simultaneously. They share `~/.dork/` (SQLite database, JSONL session files) but run separate Express server instances on different ports. This is safe because:

- SQLite uses WAL mode with file-level locking
- Session JSONL files are append-only
- Agent discovery scans `~/.claude/` (read-only)

## Testing Strategy

### Unit Tests

- **window-manager.ts**: Test bounds persistence (save/load cycle), default dimensions, maximize restore
- **server-process.ts**: Test getFreePort() returns valid port, timeout handling, shutdown sequence
- **menu.ts**: Test menu template structure has required roles
- **auto-updater.ts**: Mock electron-updater, verify checkForUpdatesAndNotify called on setup

### Integration Tests

- **Server lifecycle**: Spawn UtilityProcess, verify "ready" message received, verify HTTP responds on assigned port, verify clean shutdown
- **Window + server**: Create window, verify it loads renderer, verify renderer can reach server API

### Manual Testing Checklist

- [ ] App launches on Intel Mac
- [ ] App launches on Apple Silicon Mac
- [ ] Dashboard loads with session data from `~/.dork/`
- [ ] Can create and run a new agent session
- [ ] Window position persists after restart
- [ ] Cmd+Q shuts down cleanly (no orphan processes)
- [ ] CLI and desktop app run simultaneously without conflict
- [ ] DMG installs correctly
- [ ] Auto-update prompt appears when new version available

## Performance Considerations

- **Cold start**: ~2-3 seconds (Electron boot + Express initialization + SQLite open). Display a loading indicator.
- **HTTP latency**: ~1ms per request over localhost. Imperceptible for UI interactions.
- **Memory**: Electron baseline ~100MB + Express server ~50MB + SQLite cache. Total ~200-300MB.
- **Disk**: DMG ~150-200MB (Electron runtime + Chromium + Node.js + app code).
- **Universal binary**: Doubles the native module size but ensures both Intel and Apple Silicon work.

## Security Considerations

- **Context isolation** is enforced — renderer has no direct Node.js access
- **Preload** uses `contextBridge.exposeInMainWorld` — never exposes raw `ipcRenderer`
- **Hardened runtime** with JIT entitlement for V8
- **Code signing** with Apple Developer certificate
- **Notarization** via App Store Connect API keys in CI
- Server listens on `localhost` only — not exposed to network
- `better-sqlite3` native binary unpacked from ASAR and signed

## Documentation

- Add "Desktop App" section to `docs/` (installation, first launch, FAQ)
- Add `brew install --cask dorkos` to installation guide
- Update `contributing/architecture.md` with desktop app architecture diagram
- Add `apps/desktop/README.md` with dev setup instructions

## Implementation Phases

### Phase 1: Core Shell

- Create `apps/desktop/` with main process, preload, server-entry
- electron-vite config pointing renderer at `apps/client`
- UtilityProcess server lifecycle (start, ready signal, shutdown)
- BrowserWindow with full AppShell loading
- Window state persistence
- Native macOS menu

### Phase 2: Packaging & Distribution

- electron-builder config for macOS DMG (universal binary)
- `@electron/rebuild` for better-sqlite3
- ASAR unpacking for native modules
- Entitlements plist
- turbo.json task additions

### Phase 3: Signing & Auto-Updates (Deferred — requires Apple Developer Account)

- Code signing with Apple Developer certificate
- Notarization via App Store Connect API
- electron-updater with GitHub Releases
- CI workflow for building signed releases
- Homebrew Cask formula

### Phase 4: Polish

- Server crash recovery UI
- Loading indicator during server startup
- About dialog with version info
- `main.tsx` Electron detection (5-line change)
- Type declarations for `window.electronAPI`

## Open Questions

1. ~~**Apple Developer Account**~~ (RESOLVED)
   **Answer:** Skip signing for now. Ship unsigned builds initially — users right-click > Open to bypass Gatekeeper. Add signing when an Apple Developer account is obtained.
   **Impact:** Phase 3 (signing + auto-updates) is deferred. Phases 1-2 ship unsigned dev builds.

2. ~~**App Icon**~~ (RESOLVED)
   **Answer:** Use the existing SVG Dork logo from the codebase. Convert SVG → .icns using `svg2icns` or ImageMagick (`convert logo.svg -resize 1024x1024 icon.png && png2icns icon.icns icon.png`) during the build step.

3. ~~**Renderer Strategy**~~ (RESOLVED)
   **Answer:** Point electron-vite renderer root at `apps/client/src` (zero duplication). Shares index.html, CSS, and all components — same approach the Obsidian plugin uses conceptually.

## Related ADRs

- **ADR-0001**: Hexagonal architecture with Transport interface — the foundation enabling multiple distribution channels
- **ADR-0085**: AgentRuntime interface abstraction — server-side SDK encapsulation reused by Electron's UtilityProcess

## References

- [electron-vite documentation](https://electron-vite.org/guide/)
- [Electron UtilityProcess API](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron contextBridge API](https://www.electronjs.org/docs/latest/api/context-bridge)
- [electron-builder macOS config](https://www.electron.build/mac.html)
- [electron-updater docs](https://www.electron.build/auto-update.html)
- [macOS code signing guide](https://www.electron.build/code-signing-mac.html)
- Research: `research/20260324_electron_desktop_app_monorepo.md`
- Ideation: `specs/electron-desktop-app/01-ideation.md`
