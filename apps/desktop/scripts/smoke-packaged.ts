import { execFileSync, spawn, spawnSync } from 'child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { LOGIN_SHELL_PATH_MARKER } from '../src/shared/login-shell-path';
import { TRAY_IMAGE_FILES } from '../src/shared/tray-images';

/**
 * Packaged-runtime smoke test for the macOS desktop app.
 *
 * Unit tests mock `electron` and never start a real app; `pnpm build` only
 * proves the bundles emit. Everything between those two — the main process
 * forking `dist/server/server-entry.mjs` out of `app.asar`, that bundle
 * `dlopen`ing the Electron-ABI native modules from `app.asar.unpacked`, the
 * server binding a port and serving the packaged renderer — is first exercised
 * by a real launch. Several shipped defects lived exactly there (a dead server
 * port after a restart, a stale renderer URL, a wrong window state), all
 * invisible to every other gate in the repo.
 *
 * So: launch the packaged app, prove its server answers, prove it can see the
 * machine it is running on, and prove it shuts down without orphaning that
 * server. Any failure exits non-zero.
 *
 * That middle part is the newest and the least obvious (DOR-1335). A packaged
 * app that starts is not a packaged app that works: 0.61.0 launched perfectly
 * while reporting its own bundled Claude Code as missing, registering no Codex
 * runtime at all, opening on a directory its own boundary check refused, and
 * failing to compile its bundled marketplace extension every single time. All
 * four are packaging and environment faults, all four are invisible to a health
 * probe, and all four are asserted in {@link assertAppSeesItsMachine} — under a
 * launchd-style environment, because inheriting a developer's PATH would let
 * the machine's own tools answer for the ones the app was supposed to ship.
 *
 * Run it after packaging (`electron-builder --dir` is enough — no signing
 * needed):
 *
 * ```bash
 * pnpm --filter @dorkos/desktop exec tsx scripts/rebuild-natives.ts
 * cd apps/desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir
 * pnpm --filter @dorkos/desktop exec tsx scripts/smoke-packaged.ts
 * ```
 *
 * Running it locally leaves the shared native modules built for Electron's ABI
 * — `pnpm rebuild better-sqlite3 node-pty` from the repo root afterwards, or
 * vitest dies monorepo-wide (contributing/desktop-app-development.md §2).
 */

const DESKTOP_PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_DIR = path.join(DESKTOP_PKG, 'release');

/**
 * How long to wait for the packaged app's server to answer `/api/health`.
 *
 * The app's own ceiling is 70s (`src/shared/boot-timeouts.ts` — the parent's
 * wait for the server child's `ready` message), and a cold runner pays app
 * launch plus first-run DB migrations on top of it. Deliberately generous:
 * polling returns the moment the server answers, so a healthy boot never pays
 * the ceiling — only a broken one does, once.
 */
const SERVER_READY_BUDGET_MS = 120_000;

/** How long the app gets to exit after being asked to quit. */
const QUIT_BUDGET_MS = 30_000;

/** How long the server port gets to stop answering after the app has exited. */
const PORT_RELEASE_BUDGET_MS = 10_000;

/** Gap between poll attempts, for every poll loop here. */
const POLL_INTERVAL_MS = 1_000;

/** Per-probe timeout for a `/api/health` request. */
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

/**
 * Timeout for the API reads the runtime assertions make.
 *
 * Much longer than the health probe, because these do real work:
 * `/api/system/requirements` runs every runtime's dependency probe, each of
 * which spawns a binary under its own ~5s cap. Two seconds would abort a
 * healthy answer and read as a broken app.
 */
const API_READ_TIMEOUT_MS = 30_000;

/**
 * Lines of app output to print when the smoke fails. The app logs steadily
 * while it runs, so an uncapped dump buries the interesting part (a crash, a
 * stack trace) under minutes of routine chatter — and the interesting part is
 * almost always at the end.
 */
const FAILURE_OUTPUT_LINES = 200;

/**
 * The PATH a Finder-, Dock- or Spotlight-launched app inherits.
 *
 * launchd hands out exactly these four directories, and this smoke launches the
 * app with nothing else so the run reproduces a real double-click rather than
 * the terminal it happens to be started from. Every runtime assertion below is
 * only meaningful under this PATH: with the developer's own PATH inherited, a
 * `claude` on it would satisfy the Claude check no matter what the app packaged.
 */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** Version the fake `opencode` reports — distinctive, so nothing else can produce it. */
const FAKE_OPENCODE_VERSION = '0.0.0-dorkos-smoke';

/**
 * Runtimes the packaged app has to register — all three, every launch.
 *
 * 0.61.0 shipped with two: `@openai/codex`'s per-platform binary package was
 * missing from `app.asar`, the SDK threw at construction, and
 * `registerOptionalRuntime` swallowed it, so the Codex card in the app was
 * drawn entirely from config and the payload never mentioned it.
 */
const EXPECTED_RUNTIMES = ['claude-code', 'codex', 'opencode'];

/**
 * Log lines that are a failed boot on their own, whatever else went right.
 *
 * Both were on every launch of 0.61.0, and neither made the app fail to start —
 * which is exactly why they need asserting here rather than being left to
 * whoever reads the log.
 */
const FORBIDDEN_LOG_LINES: ReadonlyArray<{ pattern: string; why: string }> = [
  {
    pattern: 'Compilation failed for marketplace',
    why: "the bundled marketplace extension could not be compiled — esbuild's per-platform binary is missing or unspawnable",
  },
  {
    pattern: 'runtime listing degraded',
    why: 'the session list was refused — almost always a default working directory outside the boundary (DORKOS_DEFAULT_CWD)',
  },
];

/** The `/api/health` payload this smoke asserts against (apps/server/src/routes/health.ts). */
interface HealthResponse {
  /** `'ok'` once the server is serving. */
  status?: string;
  /** Server version — `__CLI_VERSION__`, injected by scripts/build-server.ts. */
  version?: string;
}

/** One dependency probe result (packages/shared/src/agent-runtime.ts's `DependencyCheck`). */
interface DependencyCheck {
  /** Human-readable name, e.g. `Claude Code CLI`. */
  name: string;
  /** `satisfied` | `missing` | `outdated`. */
  status: string;
  /** The version the binary reported, when it ran. */
  version?: string;
}

/** `GET /api/system/requirements` (apps/server/src/routes/system.ts's `SystemRequirements`). */
interface SystemRequirementsResponse {
  /** Keyed by runtime type. */
  runtimes?: Record<string, { dependencies?: DependencyCheck[]; state?: string }>;
}

/** `GET /api/directory/default`. */
interface DirectoryDefaultResponse {
  /** The server's boundary-clamped default working directory. */
  path?: string;
}

/** `GET /api/sessions` — the `{ sessions, warnings? }` envelope (ADR-0310). */
interface SessionListResponse {
  /** Per-runtime degradation notices. Absent when every runtime answered. */
  warnings?: string[];
}

/** Sleep for `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The bundle name electron-builder produces, from `productName` in
 * `electron-builder.yml`. Hardcoded rather than parsed: unlike `appId`, this
 * one is already asserted against the packaged `Info.plist` further down, so a
 * rename shows up as a clear mismatch rather than a silent miss.
 */
const PACKAGED_APP_BUNDLE = 'DorkOS.app';

/**
 * Locate the packaged `.app` bundle electron-builder produced.
 *
 * Matches `DorkOS.app` by name rather than taking the first `*.app` it finds.
 * electron-builder copies the Electron template in as `Electron.app` and
 * renames it at the end, so a pack that was interrupted — or one still running
 * — leaves an `Electron.app` sitting in the same directory. Taking the first
 * match launched THAT: a bare Electron with no app, which fails minutes later
 * as "no /api/health response" and reads exactly like a broken build.
 *
 * @returns Absolute path to the `.app` bundle.
 * @throws If no packaged app is present.
 */
function findPackagedApp(): string {
  // electron-builder names the dir per arch (`mac-arm64`, `mac-x64`, plain
  // `mac` for a universal build), so match the family rather than one name.
  const archDirs = existsSync(RELEASE_DIR)
    ? readdirSync(RELEASE_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
        .map((entry) => path.join(RELEASE_DIR, entry.name))
    : [];
  for (const dir of archDirs) {
    const bundle = path.join(dir, PACKAGED_APP_BUNDLE);
    if (existsSync(bundle)) return bundle;
  }
  const strays = archDirs.flatMap((dir) =>
    readdirSync(dir).filter((name) => name.endsWith('.app'))
  );
  throw new Error(
    `No ${PACKAGED_APP_BUNDLE} found under ${RELEASE_DIR}` +
      (strays.length > 0
        ? ` (found ${strays.join(', ')} — an interrupted or still-running pack leaves ` +
          `Electron.app behind; let it finish, or delete the release directory and repack)`
        : '') +
      `. Package one first:\n` +
      `  cd apps/desktop && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir`
  );
}

/**
 * Read a value out of the packaged app's `Info.plist`.
 *
 * @param appPath - Absolute path to the `.app` bundle.
 * @param key - The `Info.plist` key to read (e.g. `CFBundleIdentifier`).
 */
function readInfoPlist(appPath: string, key: string): string {
  return execFileSync('defaults', ['read', path.join(appPath, 'Contents', 'Info'), key], {
    encoding: 'utf-8',
  }).trim();
}

/**
 * Assert the packaged bundle identifier is the one `electron-builder.yml`
 * declares.
 *
 * The identity in `Info.plist` is what macOS keys everything off — the
 * `dorkos://` protocol registration, the single-instance lock, Keychain items,
 * the `userData` directory, and which app an auto-update replaces. If it ever
 * silently stops matching `appId`, an update ships as a *second* app rather
 * than replacing the first. Reading the packed plist and comparing it to the
 * config makes that a build failure instead of a support thread.
 *
 * `appId` is parsed with a regex rather than a YAML dependency: it is a flat,
 * unquoted, top-level scalar in this file, and adding a parser to a smoke
 * script to read one line is not a trade worth making.
 *
 * @param appPath - Absolute path to the `.app` bundle.
 * @returns The verified bundle identifier.
 * @throws If the config declares an `appId` and the packaged app disagrees.
 */
function assertBundleIdMatchesConfig(appPath: string): string {
  const packaged = readInfoPlist(appPath, 'CFBundleIdentifier');
  const config = readFileSync(path.join(DESKTOP_PKG, 'electron-builder.yml'), 'utf-8');
  const declared = /^appId:\s*(\S+)/m.exec(config)?.[1];
  if (!declared) {
    throw new Error(
      `Could not read appId from electron-builder.yml. If it moved or gained quoting, update ` +
        `assertBundleIdMatchesConfig — do not delete the check.`
    );
  }
  if (packaged !== declared) {
    throw new Error(
      `Packaged CFBundleIdentifier is "${packaged}" but electron-builder.yml declares ` +
        `appId "${declared}". macOS keys deep links, the single-instance lock and auto-update ` +
        `replacement off this identity; a mismatch ships an update as a second app.`
    );
  }
  return packaged;
}

/** One entry in an asar directory listing: a file, or a directory of more entries. */
interface AsarEntry {
  files?: Record<string, AsarEntry>;
}

/**
 * Read an `app.asar`'s directory listing without unpacking it.
 *
 * The archive starts with two pickles: an 8-byte one holding the size of the
 * second, and the second holding the directory as a JSON string. Both are
 * length-prefixed, so the four `UInt32LE`s below locate the JSON exactly. This
 * is hand-rolled for the same reason `assertBundleIdMatchesConfig` hand-rolls
 * its regex: `@electron/asar` is only a transitive dependency here, and adding
 * a direct one to read a header in a smoke script is not a trade worth making.
 *
 * @param asarPath - Absolute path to the archive.
 * @returns The archive's root directory entry.
 */
function readAsarDirectory(asarPath: string): AsarEntry {
  const fd = openSync(asarPath, 'r');
  try {
    const sizes = Buffer.alloc(16);
    readSync(fd, sizes, 0, sizes.length, 0);
    const headerStringLength = sizes.readUInt32LE(12);
    const header = Buffer.alloc(headerStringLength);
    readSync(fd, header, 0, headerStringLength, sizes.length);
    return JSON.parse(header.toString('utf-8')) as AsarEntry;
  } finally {
    closeSync(fd);
  }
}

/**
 * Assert the tray images are actually inside `app.asar`.
 *
 * They are the one runtime asset that does not come from `src/`: they are
 * authored in `build/`, which electron-builder treats as *build* resources and
 * never packages, and reach the app only because `electron.vite.config.ts`
 * emits them into `dist/main/`. Break that link — rename a file, add a platform
 * to one list and not the other, tighten the `files` allowlist — and the build
 * stays green while the shipped app comes up with no tray, which is also the
 * app that no longer quits when you close its window.
 *
 * The list comes from `src/shared/tray-images.ts`, the same constant the loader
 * and the build read, so this checks the real contract rather than a copy of it.
 *
 * @param appPath - Absolute path to the `.app` bundle.
 * @throws If the archive is unreadable or any expected image is missing.
 */
function assertTrayImagesPackaged(appPath: string): void {
  const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
  const packedMain = readAsarDirectory(asarPath).files?.dist?.files?.main?.files;
  if (!packedMain) {
    throw new Error(
      `Could not read dist/main out of ${asarPath}. If the packaged layout changed, update ` +
        `assertTrayImagesPackaged — do not delete the check.`
    );
  }
  const missing = TRAY_IMAGE_FILES.filter((fileName) => !(fileName in packedMain));
  if (missing.length > 0) {
    throw new Error(
      `Packaged app.asar is missing tray images in dist/main: ${missing.join(', ')}. They are ` +
        `authored in build/, which is NOT packaged; electron.vite.config.ts emits them into ` +
        `dist/main so electron-builder.yml's files allowlist ships them. Without them the app ` +
        `runs with no tray — and an app with no tray and no window is unreachable.`
    );
  }
}

/**
 * The tunnel binary, as the packaged app has to carry it.
 *
 * macOS/arm64 because this smoke only ever runs against a `.app` bundle (see
 * `main`); the Windows counterpart (`…-win32-x64-msvc/ngrok.win32-x64-msvc.node`)
 * rides `desktop-release.yml`'s `verify-windows` job instead.
 */
const TUNNEL_BINARY = path.join(
  'node_modules',
  '@ngrok',
  'ngrok-darwin-arm64',
  'ngrok.darwin-arm64.node'
);

/** Smallest the tunnel binary could plausibly be — it is ~9 MB in practice. */
const TUNNEL_BINARY_MIN_BYTES = 1_000_000;

/**
 * Assert the ngrok binary Remote Access loads is really on disk, outside the
 * asar.
 *
 * This is the one family of the four whose absence no runtime assertion in this
 * file can see: Claude and Codex show up as unregistered runtimes, esbuild as a
 * failed marketplace compilation, but a missing tunnel binary is invisible
 * until someone turns Remote Access on — which needs an ngrok account and a
 * network, so it cannot be part of a hermetic smoke. What CAN be checked
 * without either is that the file the loader will `dlopen` exists and is a
 * binary rather than a stub.
 *
 * Checked against the packaged app rather than the config, deliberately.
 * `scripts/build-server.ts` already proves `package.json` and
 * `electron-builder.yml` agree — 0.66.0's failure was one level below that:
 * the configuration was answerable and the copier still put nothing in the
 * app, and only the artifact can tell you so (#1458).
 *
 * @param appPath - Absolute path to the `.app` bundle.
 * @throws If the binary is missing or implausibly small.
 */
function assertTunnelBinaryUnpacked(appPath: string): void {
  const binary = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', TUNNEL_BINARY);
  if (!existsSync(binary)) {
    throw new Error(
      `Packaged app has no tunnel binary at app.asar.unpacked/${TUNNEL_BINARY}. Remote Access ` +
        `would fail the moment it is switched on, with "Failed to load native binding" and a ` +
        `bare 500 — the app boots and looks healthy either way (#1458). Check that ` +
        `@ngrok/ngrok-darwin-arm64 is in package.json's optionalDependencies AND has an ` +
        `asarUnpack glob in electron-builder.yml.`
    );
  }
  const { size } = statSync(binary);
  if (size < TUNNEL_BINARY_MIN_BYTES) {
    throw new Error(
      `The packaged tunnel binary is ${size} bytes (expected at least ` +
        `${TUNNEL_BINARY_MIN_BYTES}). That is not a Mach-O library — a placeholder or a ` +
        `truncated copy would pass an existence check and still fail to dlopen.`
    );
  }
}

/**
 * Make an unsigned build launchable, without touching a signed one.
 *
 * `hardenedRuntime: true` turns on macOS **library validation**: every Mach-O
 * loaded into the process must share the main executable's signing identity.
 * A Developer ID build satisfies that — electron-builder signs the app, its
 * frameworks and its native modules with one identity. An unsigned build may
 * not: when electron-builder ad-hoc-signs each binary separately, the loader
 * refuses the app's own Electron Framework with
 *
 * > Library not loaded: @rpath/Electron Framework.framework/Electron Framework
 * > … mapping process and mapped file (non-platform) have different Team IDs
 *
 * and the app dies before `main` runs. Re-signing ad-hoc in one pass clears the
 * hardened-runtime flag and makes it load.
 *
 * This does not weaken what the smoke proves. Library validation is about
 * *code identity*, not about the packaged layout, the asar reads, the native
 * `dlopen`s or the server boot — the things under test here. The shipped build
 * keeps `hardenedRuntime: true` (with the entitlements that make it work), and
 * `desktop-release.yml`'s verify-macos job is what asserts its signature.
 *
 * Conditional, not unconditional, because it is not always needed — a local
 * pack hit this; the same pack on a GitHub macOS runner did not (electron-
 * builder left the Electron-signed binaries alone there). A build signed with a
 * real identity is left strictly alone either way: re-signing one would destroy
 * the signature the release is about to notarize.
 *
 * @param appPath - Absolute path to the `.app` bundle.
 * @returns Whether the app was re-signed.
 */
function relaxAdhocLibraryValidation(appPath: string): boolean {
  // codesign writes its description to stderr, not stdout.
  const probe = spawnSync('codesign', ['-dvvv', appPath], { encoding: 'utf-8' });
  const description = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  const isAdhoc = /^Signature=adhoc$/m.test(description);
  const hasHardenedRuntime = /flags=\S*\(.*\bruntime\b.*\)/.test(description);
  if (!isAdhoc || !hasHardenedRuntime) return false;

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  return true;
}

/** Direct children of `pid`, or `[]` if it has none. */
function childPids(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf-8' })
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    // pgrep exits 1 when a process has no children — not an error here.
    return [];
  }
}

/** Every pid in `rootPid`'s process tree, including `rootPid` itself. */
function processTree(rootPid: number): number[] {
  const pids = [rootPid];
  for (let i = 0; i < pids.length; i++) {
    for (const child of childPids(pids[i])) {
      if (!pids.includes(child)) pids.push(child);
    }
  }
  return pids;
}

/** A listening socket found in the app's process tree. */
interface Endpoint {
  /** Host as reported by lsof, already in URL form (`127.0.0.1`, `[::1]`). */
  host: string;
  /** TCP port. */
  port: number;
}

/**
 * Sockets the given processes are listening on.
 *
 * Discovering the endpoint this way — rather than scraping it out of the app's
 * log output — keeps the smoke coupled to the behavior under test (the packaged
 * app opened a listening socket) instead of to a log line's wording. Each
 * candidate is then validated by an actual `/api/health` probe, so it does not
 * matter if the tree ever holds more than one.
 *
 * The host matters as much as the port: the server binds `localhost`, which on
 * macOS resolves to IPv6 — so it listens on `[::1]` and a probe hardcoded to
 * `127.0.0.1` connects to nothing at all.
 *
 * @param pids - The process tree to inspect.
 */
function listeningEndpoints(pids: number[]): Endpoint[] {
  let output: string;
  try {
    // -F n → machine-readable output, one `n<host>:<port>` line per socket.
    output = execFileSync(
      'lsof',
      ['-nP', '-F', 'n', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(',')],
      { encoding: 'utf-8' }
    );
  } catch {
    // lsof exits 1 when nothing matches — the normal case while the app boots.
    return [];
  }
  const endpoints = new Map<string, Endpoint>();
  for (const line of output.split('\n')) {
    const match = /^n(.+):(\d+)$/.exec(line);
    if (!match) continue;
    // A wildcard bind (`*`, `[::]`) is reachable on the matching loopback.
    const reported = match[1];
    const host = reported === '*' || reported === '0.0.0.0' ? '127.0.0.1' : reported;
    const endpoint = { host: host === '[::]' ? '[::1]' : host, port: Number(match[2]) };
    endpoints.set(`${endpoint.host}:${endpoint.port}`, endpoint);
  }
  return [...endpoints.values()];
}

/**
 * Probe `/api/health` on one endpoint.
 *
 * @param endpoint - The candidate socket.
 * @returns The parsed health payload, or `null` if this is not our server.
 */
async function probeHealth(endpoint: Endpoint): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as HealthResponse;
    return body?.status === 'ok' ? body : null;
  } catch {
    return null;
  }
}

/** A launched packaged app, with everything the smoke needs to observe it. */
interface LaunchedApp {
  /** pid of the app's main process. */
  pid: number;
  /** Exit code, once the process has exited; `null` if a signal killed it. */
  exitCode: number | null;
  /** Signal that killed the process, if one did. */
  exitSignal: NodeJS.Signals | null;
  /** Whether the process has exited. */
  exited: boolean;
  /** Everything the app wrote to stdout/stderr, for failure diagnosis. */
  output: string[];
  /** Ask the main process to exit. */
  terminate(signal: NodeJS.Signals): void;
}

/** A stand-in for the user's login shell, and the tool only it can reveal. */
interface FakeLoginShell {
  /** Path to hand the app as `$SHELL`. */
  shell: string;
  /** The directory the shell's PATH adds, holding the fake `opencode`. */
  binDir: string;
}

/**
 * Build a fake login shell whose PATH exposes a tool nothing else can see.
 *
 * This is what makes the PATH fix observable from outside the app. A packaged
 * app inherits launchd's four system directories and nothing more, so it used
 * to be blind to everything under `~/.local/bin`, `/opt/homebrew/bin` or
 * `~/.nvm` — the reason a tester's `claude` and `codex` both read as "missing"
 * in the Mac app while his terminal found them instantly. The shell here prints
 * a PATH containing one directory holding one executable named `opencode`; if
 * the app reports that fake version back through
 * `GET /api/system/requirements`, the login-shell PATH reached the server.
 *
 * The shell ignores its arguments on purpose: it is standing in for the whole
 * `$SHELL -ilc …` protocol, and what is under test is that the app runs it and
 * reads what it prints, not that a real zsh parses the flags. What it does NOT
 * fake is the answer's shape — it exports a PATH and then runs the real `env`,
 * so the app parses a genuine environment dump exactly as it would from a real
 * shell (see `PROBE_SCRIPT` in `src/main/shell-path.ts` for why the probe asks
 * that way).
 *
 * @param dir - A throwaway directory to build the fixture in.
 */
function createFakeLoginShell(dir: string): FakeLoginShell {
  const binDir = path.join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });

  const opencode = path.join(binDir, 'opencode');
  writeFileSync(opencode, `#!/bin/sh\necho "${FAKE_OPENCODE_VERSION}"\n`, 'utf-8');
  chmodSync(opencode, 0o755);

  const shell = path.join(dir, 'login-shell');
  writeFileSync(
    shell,
    `#!/bin/sh\n` +
      `PATH="${binDir}:${LAUNCHD_PATH}"\n` +
      `export PATH\n` +
      `printf %s '${LOGIN_SHELL_PATH_MARKER}'; env; printf %s '${LOGIN_SHELL_PATH_MARKER}'\n`,
    'utf-8'
  );
  chmodSync(shell, 0o755);

  return { shell, binDir };
}

/**
 * Launch the packaged app against a throwaway home directory.
 *
 * This has to be safe on a developer's machine, not just a disposable runner:
 * the run boots a full production server for up to two minutes, and without
 * isolation it would run the PACKAGED migration set against the developer's
 * real `~/.dork/dork.db`, write a DorkBot, stage core extensions and rewrite
 * `config.json`.
 *
 * **`HOME` alone does not do it.** `server-process.ts` derives `DORK_HOME` from
 * `app.getPath('home')`, which resolves through CoreFoundation's
 * `NSHomeDirectory()` — and that ignores `$HOME` in favour of `getpwuid`.
 * Measured against this app's own Electron:
 *
 * ```text
 * HOME=/private/tmp/fakehome  →  getPath(home)     = /Users/<real user>   ← real home
 *                                getPath(userData) = /Users/<real user>/Library/…
 * + CFFIXED_USER_HOME=…       →  getPath(home)     = /private/tmp/fakehome
 *                                getPath(userData) = /private/tmp/fakehome/Library/…
 * ```
 *
 * `CFFIXED_USER_HOME` is the knob CoreFoundation checks first, and it corrects
 * `home` and `userData` together. Both vars are set because they steer
 * different resolvers: Node's `os.homedir()` (the server child's `~/.claude`
 * lookups) honours `HOME`, Electron's `getPath` honours `CFFIXED_USER_HOME`.
 * Setting only one leaves the app HALF isolated — which is worse than none,
 * because it looks contained while writing to the real database.
 *
 * {@link assertDataDirIsolated} proves this actually held, every run. Do not
 * drop either variable or that assertion.
 *
 * The environment is also cut down to what launchd hands a double-clicked app:
 * {@link LAUNCHD_PATH} and a `$SHELL` pointing at {@link createFakeLoginShell}'s
 * stand-in. That is not incidental tidying — it is what gives the runtime
 * assertions their meaning. Inheriting this machine's PATH would let a `claude`
 * or `codex` installed on the runner satisfy the checks no matter what the app
 * actually packaged, which is the failure mode a green smoke must not have.
 *
 * @param appPath - Absolute path to the `.app` bundle.
 * @param home - Absolute path to the throwaway home directory.
 * @param loginShell - The fake login shell to hand the app as `$SHELL`.
 */
function launchApp(appPath: string, home: string, loginShell: FakeLoginShell): LaunchedApp {
  const executable = path.join(appPath, 'Contents', 'MacOS', path.basename(appPath, '.app'));
  const child = spawn(executable, [], {
    env: {
      ...process.env,
      HOME: home,
      CFFIXED_USER_HOME: home,
      ELECTRON_ENABLE_LOGGING: '1',
      PATH: LAUNCHD_PATH,
      SHELL: loginShell.shell,
      // This app is launched from `release/`, which is exactly the
      // not-in-Applications state the install-location guard offers to fix —
      // and it offers with a modal dialog raised *before* the server starts.
      // With nobody here to answer it, the app would never reach
      // `/api/health` and every run would fail as a 120s timeout with no
      // output, which is indistinguishable from the Gatekeeper hang above.
      DORKOS_DESKTOP_SUPPRESS_INSTALL_PROMPT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const app: LaunchedApp = {
    pid: child.pid!,
    exitCode: null,
    exitSignal: null,
    exited: false,
    output: [],
    terminate: (signal) => {
      if (!app.exited) child.kill(signal);
    },
  };

  const capture = (chunk: Buffer): void => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) app.output.push(line);
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('exit', (code, signal) => {
    app.exited = true;
    app.exitCode = code;
    app.exitSignal = signal;
  });

  return app;
}

/**
 * Poll until the app's server answers `/api/health`.
 *
 * @param app - The launched app.
 * @returns The serving port and its health payload.
 * @throws If the app exits first, or nothing answers within the budget.
 */
async function waitForHealthyServer(
  app: LaunchedApp
): Promise<{ endpoint: Endpoint; health: HealthResponse }> {
  const deadline = Date.now() + SERVER_READY_BUDGET_MS;
  while (Date.now() < deadline) {
    if (app.exited) {
      throw new Error(`The app exited (code ${app.exitCode}) before its server came up.`);
    }
    for (const endpoint of listeningEndpoints(processTree(app.pid))) {
      const health = await probeHealth(endpoint);
      if (health) return { endpoint, health };
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `No /api/health response within ${SERVER_READY_BUDGET_MS / 1000}s.\n` +
      `If the app produced NO output at all above and sat at 0% CPU, suspect the macOS ` +
      `Gatekeeper consent dialog rather than a code defect — it blocks launch until a human ` +
      `clicks Open, and is indistinguishable from a hang here. See ` +
      `contributing/desktop-app-development.md §6; this script already runs \`xattr -cr\`, ` +
      `which is the fix.`
  );
}

/**
 * Ask the app to quit and wait for it to go.
 *
 * SIGTERM rather than an AppleScript `quit` event: sending Apple Events needs
 * TCC automation consent, which no CI runner grants, so `osascript` would turn
 * a working app into a red build. SIGTERM is what a supervisor sends anyway.
 *
 * @param app - The launched app.
 * @throws If the app is still running after {@link QUIT_BUDGET_MS}.
 */
async function quitApp(app: LaunchedApp): Promise<void> {
  app.terminate('SIGTERM');
  const deadline = Date.now() + QUIT_BUDGET_MS;
  while (Date.now() < deadline) {
    if (app.exited) return;
    await delay(POLL_INTERVAL_MS);
  }
  app.terminate('SIGKILL');
  throw new Error(
    `The app ignored SIGTERM for ${QUIT_BUDGET_MS / 1000}s (SIGKILLed). A packaged app that ` +
      `cannot be shut down leaves its server process and SQLite store behind.`
  );
}

/**
 * Assert the app actually wrote its data directory inside the throwaway home.
 *
 * The whole isolation argument in {@link launchApp} is an argument about how
 * two OS-level resolvers behave. This is the part that makes it a fact: if the
 * server's SQLite store is here, `DORK_HOME` resolved into the throwaway tree,
 * and the developer's real `~/.dork` was not touched. It catches a dropped env
 * var, and it would have caught the `HOME`-only version of this script — which
 * looked isolated, read green in CI (a runner's home is disposable), and
 * quietly migrated the real database on a developer's machine.
 *
 * Runs after the health probe, by which point the server has created the store
 * and run its migrations.
 *
 * @param home - The throwaway home the app was launched against.
 * @throws If the data directory is not inside `home`.
 */
function assertDataDirIsolated(home: string): void {
  // apps/server/src/index.ts: `path.join(dorkHome, 'dork.db')`, where dorkHome
  // is the DORK_HOME that server-process.ts derived from app.getPath('home').
  const db = path.join(home, '.dork', 'dork.db');
  if (existsSync(db)) return;
  throw new Error(
    `The app did not write its database inside the throwaway home — expected ${db}.\n` +
      `That means DORK_HOME resolved somewhere else, almost certainly the real ~/.dork, and ` +
      `this run just booted a production server against it. Check that launchApp still sets ` +
      `BOTH HOME and CFFIXED_USER_HOME (see its comment for why neither alone is enough).`
  );
}

/**
 * The counter file the renderer supervisor writes on every heartbeat
 * (`src/main/renderer-health/index.ts`).
 */
const RENDERER_HEALTH_FILE = 'renderer-health.json';

/**
 * How long to wait for the window to report a first paint, after the server is
 * already healthy.
 *
 * The supervisor's own deadline is 10s from the load, and the window is only
 * created once the server is up — so this is that deadline plus room for a
 * cold runner to paint, and no more. Waiting longer would mean a build whose
 * window comes up late reads the same as one that comes up.
 */
const RENDER_BUDGET_MS = 45_000;

/** Depth to search `Application Support` for {@link RENDERER_HEALTH_FILE}. */
const HEALTH_SEARCH_DEPTH = 3;

/** What the supervisor writes; only the fields this smoke reads. */
interface RendererHealthFile {
  /** Renderer failures since the last first paint. */
  consecutiveFailures?: number;
  /** When the record was last written. */
  updatedAt?: string;
}

/**
 * Find the renderer health file somewhere under the throwaway home.
 *
 * Searched rather than composed, because the directory it lands in is
 * `app.getPath('userData')` — Electron's own answer, built from an app name
 * that lives in packaging config rather than in this source. Composing the
 * path here would turn a rename into a confident "the window never painted",
 * which is the loudest possible false alarm.
 *
 * @param home - The throwaway home the app was launched against.
 * @returns Absolute path of the file, or `null` if it is not there yet.
 */
export function findRendererHealthFile(home: string): string | null {
  const roots = [path.join(home, 'Library', 'Application Support'), home];
  const search = (dir: string, depth: number): string | null => {
    if (depth > HEALTH_SEARCH_DEPTH) return null;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Not created yet, or not ours to read.
      return null;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === RENDERER_HEALTH_FILE) {
        return path.join(dir, entry.name);
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = search(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  for (const root of roots) {
    const found = search(root, 0);
    if (found) return found;
  }
  return null;
}

/**
 * Does this health record show a window that painted on **this** launch?
 *
 * Three claims in one, and all three are needed. A record at all means the
 * heartbeat IPC arrived; `consecutiveFailures: 0` means the supervisor was not
 * mid-recovery when it wrote; and an `updatedAt` after the launch means it is
 * this run's record rather than one a previous run left in the directory.
 *
 * @param contents - The file's raw contents.
 * @param launchedAt - Epoch milliseconds the app was spawned at.
 * @returns `null` when the record proves a paint, otherwise why it does not.
 */
export function rendererPaintFailure(contents: string, launchedAt: number): string | null {
  let parsed: RendererHealthFile;
  try {
    parsed = JSON.parse(contents) as RendererHealthFile;
  } catch {
    return `${RENDERER_HEALTH_FILE} is not readable JSON: ${contents.slice(0, 200)}`;
  }
  const updatedAt = parsed.updatedAt ? Date.parse(parsed.updatedAt) : NaN;
  if (Number.isNaN(updatedAt)) return `${RENDERER_HEALTH_FILE} has no usable updatedAt.`;
  // A second of slack: the file's timestamp comes from the app's clock and the
  // launch time from this process's, and they are not the same reading.
  if (updatedAt < launchedAt - 1_000) {
    return (
      `${RENDERER_HEALTH_FILE} was last written ${new Date(updatedAt).toISOString()}, before this ` +
      `launch at ${new Date(launchedAt).toISOString()} — the window never reported a first paint.`
    );
  }
  if (parsed.consecutiveFailures !== 0) {
    return (
      `The renderer supervisor recorded ${parsed.consecutiveFailures} consecutive failure(s), so ` +
      `the window did not come up on its own.`
    );
  }
  return null;
}

/**
 * Assert the packaged app's window actually rendered.
 *
 * **This is the gate for the whole "packages green, black on install" class.**
 * v0.63.0 passed every check this script had: it launched, served, quit
 * cleanly, and showed every user a black rectangle, because the renderer
 * bundle threw before React mounted (DOR-1448). Nothing here can see a window,
 * so it reads the artifact that stands in for one: the heartbeat the renderer
 * supervisor records.
 *
 * Be precise about what that proves. The heartbeat says the renderer got far
 * enough to run the client's own boot script and report itself — the bundle
 * loaded and evaluated, which is exactly what v0.63.0 could not do. It does
 * NOT prove the window is laid out correctly or that any pixel is the right
 * colour; a heartbeat also arrives from the sentinel's own failure panel,
 * which is a readable screen rather than a working app. This gate catches
 * "nothing rendered", not "it rendered wrong".
 *
 * @param home - The throwaway home the app was launched against.
 * @param app - The launched app, so a crash is reported as a crash.
 * @param launchedAt - Epoch milliseconds the app was spawned at.
 * @throws If no window reported a first paint within {@link RENDER_BUDGET_MS}.
 */
async function assertRendererPainted(
  home: string,
  app: LaunchedApp,
  launchedAt: number
): Promise<void> {
  const deadline = Date.now() + RENDER_BUDGET_MS;
  let lastFailure = `${RENDERER_HEALTH_FILE} never appeared under ${home}.`;
  while (Date.now() < deadline) {
    if (app.exited) {
      throw new Error(`The app exited (code ${app.exitCode}) before its window reported a paint.`);
    }
    const file = findRendererHealthFile(home);
    if (file) {
      try {
        lastFailure = rendererPaintFailure(readFileSync(file, 'utf-8'), launchedAt) ?? '';
      } catch (err) {
        // A read that lost a race with the app's own write; try again.
        lastFailure = `${file} could not be read: ${String(err)}`;
      }
      if (lastFailure === '') return;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `The packaged app's window never reported that it rendered.\n${lastFailure}\n\n` +
      `This is the check that catches a build which launches, serves and quits cleanly while ` +
      `showing every user a black window (DOR-1448). Do not weaken it: run the app by hand and ` +
      `look at the window before assuming the check is wrong.`
  );
}

/** One thing this smoke claims about the running app. */
interface Assertion {
  /** What is being claimed, phrased as the passing case. */
  label: string;
  /** `null` when it held; otherwise what was found instead. */
  failure: string | null;
}

/** Record an assertion from a condition and the detail to print when it fails. */
function claim(label: string, ok: boolean, detail: () => string): Assertion {
  return { label, failure: ok ? null : detail() };
}

/**
 * Fetch and parse one JSON endpoint on the running app.
 *
 * @param endpoint - The socket the server is serving on.
 * @param apiPath - Path to request, e.g. `/api/sessions`.
 * @throws If the request fails or the response is not 2xx — an endpoint that
 *   cannot be read is a failure of the app, not of this helper.
 */
async function getJson<T>(endpoint: Endpoint, apiPath: string): Promise<T> {
  const url = `http://${endpoint.host}:${endpoint.port}${apiPath}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(API_READ_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return (await response.json()) as T;
}

/** The dependency check whose name reads as a CLI probe, mirroring `deriveRuntimeReadiness`. */
function cliCheck(checks: DependencyCheck[] | undefined): DependencyCheck | undefined {
  return checks?.find((check) => /\bCLI\b/i.test(check.name));
}

/** Compare two paths as the filesystem sees them (`/var` is a symlink to `/private/var`). */
function samePathTree(child: string, parent: string): boolean {
  const real = (value: string): string => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  const [childReal, parentReal] = [real(child), real(parent)];
  return childReal === parentReal || childReal.startsWith(parentReal + path.sep);
}

/**
 * Assert the packaged app can actually see the machine it is running on.
 *
 * Everything here failed, silently, in the shipped 0.61.0 Mac app: it reported
 * its own bundled Claude Code as missing, registered no Codex runtime at all,
 * opened on a directory its own boundary check then refused, and failed to
 * compile its bundled marketplace extension on every launch. None of it stopped
 * the app from starting, so none of it was caught by anything — which is what
 * these assertions are for. They are only meaningful because {@link launchApp}
 * strips the environment down to what launchd gives a double-clicked app.
 *
 * Every claim is printed, pass or fail, so a green run says what it proved
 * rather than only that nothing threw.
 *
 * @param endpoint - The socket the server is serving on.
 * @param home - The throwaway home the app was launched against.
 * @param output - Everything the app has written so far.
 * @throws If any claim does not hold, naming all of them and the payloads.
 */
async function assertAppSeesItsMachine(
  endpoint: Endpoint,
  home: string,
  output: string[]
): Promise<void> {
  const requirements = await getJson<SystemRequirementsResponse>(
    endpoint,
    '/api/system/requirements'
  );
  const runtimes = requirements.runtimes ?? {};
  const registered = Object.keys(runtimes).sort();
  const claudeCli = cliCheck(runtimes['claude-code']?.dependencies);
  const codexCli = cliCheck(runtimes['codex']?.dependencies);
  const openCodeCli = cliCheck(runtimes['opencode']?.dependencies);

  const defaultDirectory = await getJson<DirectoryDefaultResponse>(
    endpoint,
    '/api/directory/default'
  );
  const sessions = await getJson<SessionListResponse>(endpoint, '/api/sessions');
  // The app's output reaches this process through a pipe, so a line written
  // while the requests above were in flight can still be in transit. One poll
  // interval closes that gap; the payload assertions above do not depend on it.
  await delay(POLL_INTERVAL_MS);
  const logs = output.join('\n');

  const assertions: Assertion[] = [
    claim(
      `every runtime registered (${EXPECTED_RUNTIMES.join(', ')})`,
      EXPECTED_RUNTIMES.every((type) => registered.includes(type)),
      () => `got ${registered.join(', ') || '(none)'}`
    ),
    claim(
      'Claude Code CLI satisfied from the bundled binary',
      claudeCli?.status === 'satisfied' && Boolean(claudeCli.version),
      () =>
        `${JSON.stringify(claudeCli ?? null)} — with no claude on PATH this can only pass ` +
        `through the unpacked @anthropic-ai/claude-agent-sdk-<platform> binary`
    ),
    claim(
      'Codex CLI satisfied from the vendored binary',
      codexCli?.status === 'satisfied',
      () =>
        `${JSON.stringify(codexCli ?? null)} — with no codex on PATH this can only pass ` +
        `through the unpacked @openai/codex-<platform> vendor binary`
    ),
    claim(
      'the login-shell PATH reached the server',
      openCodeCli?.status === 'satisfied' && openCodeCli.version === FAKE_OPENCODE_VERSION,
      () =>
        `${JSON.stringify(openCodeCli ?? null)} — the fake login shell put an opencode ` +
        `reporting ${FAKE_OPENCODE_VERSION} on the PATH, and only a server that read that ` +
        `PATH could find it`
    ),
    claim(
      'the default working directory is inside the home directory',
      Boolean(defaultDirectory.path) && samePathTree(defaultDirectory.path!, home),
      () => `${JSON.stringify(defaultDirectory)} is not inside ${home}`
    ),
    claim(
      'the session list came back without warnings',
      (sessions.warnings ?? []).length === 0,
      () => JSON.stringify(sessions.warnings)
    ),
    ...FORBIDDEN_LOG_LINES.map(({ pattern, why }) =>
      claim(`no "${pattern}" in the app's output`, !logs.includes(pattern), () => why)
    ),
  ];

  for (const { label, failure } of assertions) {
    console.log(`      ${failure ? '✗' : '✓'} ${label}${failure ? ` — ${failure}` : ''}`);
  }
  const failed = assertions.filter((assertion) => assertion.failure !== null);
  if (failed.length > 0) {
    throw new Error(
      `The packaged app started, but ${failed.length} of ${assertions.length} checks about ` +
        `what it can see failed:\n` +
        failed.map(({ label, failure }) => `  ✗ ${label} — ${failure}`).join('\n')
    );
  }
}

/**
 * Assert the server port stops answering once the app is gone.
 *
 * This is the orphan check: `stopServer()` shuts the server child down on
 * quit, and if it ever stops doing so the port stays held by a process with no
 * window — the exact shape of the "dead server port after a restart" class of
 * bug this smoke exists for.
 *
 * @param endpoint - The socket the server was serving on.
 * @throws If it is still answering after {@link PORT_RELEASE_BUDGET_MS}.
 */
async function assertPortReleased(endpoint: Endpoint): Promise<void> {
  const deadline = Date.now() + PORT_RELEASE_BUDGET_MS;
  while (Date.now() < deadline) {
    if ((await probeHealth(endpoint)) === null) return;
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `${endpoint.host}:${endpoint.port} is still serving /api/health ` +
      `${PORT_RELEASE_BUDGET_MS / 1000}s after the app exited — the server process was orphaned ` +
      `instead of shut down.`
  );
}

/** Run the smoke against the packaged app. */
async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error(
      `This smoke is macOS-only (it drives a .app bundle); got ${process.platform}. The Windows ` +
        `installer is verified separately by desktop-release.yml's verify-windows job.`
    );
  }

  const appPath = findPackagedApp();
  const expectedVersion = (
    JSON.parse(readFileSync(path.join(DESKTOP_PKG, 'package.json'), 'utf-8')) as { version: string }
  ).version;
  console.log(`[1/7] Packaged app: ${appPath}`);
  console.log(`      Bundle id: ${assertBundleIdMatchesConfig(appPath)} (matches appId)`);
  assertTrayImagesPackaged(appPath);
  console.log(`      Tray images: all ${TRAY_IMAGE_FILES.length} present in app.asar`);
  assertTunnelBinaryUnpacked(appPath);
  console.log(`      Tunnel binary: ${TUNNEL_BINARY} unpacked from app.asar`);

  // A freshly built app is not quarantined, so this is normally a no-op — but
  // when it is not, the failure it prevents (Gatekeeper's consent dialog
  // blocking launch, which looks exactly like a hang from here) costs hours to
  // diagnose. `-cr` clears ALL attributes: `-dr com.apple.quarantine` alone
  // misses com.apple.macl / com.apple.provenance, which re-trigger the dialog.
  // See contributing/desktop-app-development.md §6.
  execFileSync('xattr', ['-cr', appPath]);
  const resigned = relaxAdhocLibraryValidation(appPath);
  console.log(
    `[2/7] Cleared extended attributes (Gatekeeper insurance)` +
      `${resigned ? '; re-signed ad-hoc so an unsigned build can load its own framework' : ''}.`
  );

  const home = mkdtempSync(path.join(os.tmpdir(), 'dorkos-smoke-home-'));
  const fixtures = mkdtempSync(path.join(os.tmpdir(), 'dorkos-smoke-shell-'));
  const loginShell = createFakeLoginShell(fixtures);
  const launchedAt = Date.now();
  const app = launchApp(appPath, home, loginShell);
  console.log(`[3/7] Launched (pid ${app.pid}) against throwaway home ${home}`);
  console.log(`      PATH is launchd's (${LAUNCHD_PATH}); $SHELL is ${loginShell.shell}`);

  try {
    const { endpoint, health } = await waitForHealthyServer(app);
    console.log(
      `[4/7] Server healthy on ${endpoint.host}:${endpoint.port} — version ${health.version}`
    );

    // The packaged server bundle carries the desktop package's version, baked
    // in as __CLI_VERSION__ by scripts/build-server.ts. Asserting it proves the
    // app forked THAT bundle, rather than some other DorkOS server that
    // happened to be listening on the runner.
    if (health.version !== expectedVersion) {
      throw new Error(
        `/api/health reports version ${health.version}, expected ${expectedVersion} from ` +
          `apps/desktop/package.json — the app is not serving the bundle just packaged.`
      );
    }

    assertDataDirIsolated(home);

    console.log('[5/7] What the app can see from a launchd-style launch:');
    await assertAppSeesItsMachine(endpoint, home, app.output);

    await assertRendererPainted(home, app, launchedAt);
    console.log('[6/7] The window rendered — the renderer reported a first paint.');

    await quitApp(app);
    // Assert the (code, signal) PAIR, not the code alone. `child.on('exit')`
    // reports `code === null` when a signal killed the process, so a check that
    // tolerates null passes for the very outcome it should catch — a SIGTERM
    // that killed the app outright instead of being handled.
    //
    // Measured against this packaged app: SIGTERM produces `code 0, signal
    // null`, i.e. Electron runs its quit path (before-quit -> stopServer ->
    // clean exit). So a clean exit here is a real signal that shutdown ran, not
    // an accident of how the process happened to die.
    if (app.exitCode !== 0 || app.exitSignal !== null) {
      throw new Error(
        app.exitSignal !== null
          ? `The app was killed by ${app.exitSignal} rather than exiting on its own. It normally ` +
              `handles SIGTERM and exits 0, so its shutdown path (before-quit -> stopServer) did ` +
              `not run — anything it does on quit was skipped.`
          : `The app exited with code ${app.exitCode} on quit; expected a clean 0.`
      );
    }
    await assertPortReleased(endpoint);
    // Only on success: a failed run's throwaway home holds the DB and logs of
    // whatever went wrong, and the path is printed above.
    rmSync(home, { recursive: true, force: true });
    rmSync(fixtures, { recursive: true, force: true });
    console.log(
      '[7/7] Data dir isolated, quit cleanly (exit 0), port released. Packaged smoke PASSED.'
    );
  } catch (err) {
    // The app's own output is the only diagnosis material for a packaged
    // launch — print it before rethrowing, or CI shows a bare timeout.
    const tail = app.output.slice(-FAILURE_OUTPUT_LINES);
    const elided = app.output.length - tail.length;
    console.error(
      `\n--- app output${elided > 0 ? ` (last ${tail.length} of ${app.output.length} lines)` : ''} ---`
    );
    console.error(tail.length > 0 ? tail.join('\n') : '(nothing on stdout/stderr)');
    console.error('--- end app output ---\n');
    app.terminate('SIGKILL');
    throw err;
  }
}

// Run only when invoked as the script, so the pure helpers above can be
// imported and tested — the same guard `check-renderer-defines.ts` uses. A
// bare `main()` here would launch a packaged app the moment a test imported
// this file.
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err: unknown) => {
    console.error(`\n[smoke-packaged] FAILED:\n`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
