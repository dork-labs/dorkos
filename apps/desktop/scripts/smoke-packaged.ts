import { execFileSync, spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

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
 * So: launch the packaged app, prove its server answers, prove it shuts down
 * without orphaning that server. Any failure exits non-zero.
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
 * Lines of app output to print when the smoke fails. The app logs steadily
 * while it runs, so an uncapped dump buries the interesting part (a crash, a
 * stack trace) under minutes of routine chatter — and the interesting part is
 * almost always at the end.
 */
const FAILURE_OUTPUT_LINES = 200;

/** The `/api/health` payload this smoke asserts against (apps/server/src/routes/health.ts). */
interface HealthResponse {
  /** `'ok'` once the server is serving. */
  status?: string;
  /** Server version — `__CLI_VERSION__`, injected by scripts/build-server.ts. */
  version?: string;
}

/** Sleep for `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Locate the packaged `.app` bundle electron-builder produced.
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
    const bundle = readdirSync(dir).find((name) => name.endsWith('.app'));
    if (bundle) return path.join(dir, bundle);
  }
  throw new Error(
    `No packaged .app found under ${RELEASE_DIR}. Package one first:\n` +
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
 * @param appPath - Absolute path to the `.app` bundle.
 * @param home - Absolute path to the throwaway home directory.
 */
function launchApp(appPath: string, home: string): LaunchedApp {
  const executable = path.join(appPath, 'Contents', 'MacOS', path.basename(appPath, '.app'));
  const child = spawn(executable, [], {
    env: {
      ...process.env,
      HOME: home,
      CFFIXED_USER_HOME: home,
      ELECTRON_ENABLE_LOGGING: '1',
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
      `contributing/desktop-app-development.md §7; this script already runs \`xattr -cr\`, ` +
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
  console.log(`[1/5] Packaged app: ${appPath}`);
  console.log(`      Bundle id: ${assertBundleIdMatchesConfig(appPath)} (matches appId)`);

  // A freshly built app is not quarantined, so this is normally a no-op — but
  // when it is not, the failure it prevents (Gatekeeper's consent dialog
  // blocking launch, which looks exactly like a hang from here) costs hours to
  // diagnose. `-cr` clears ALL attributes: `-dr com.apple.quarantine` alone
  // misses com.apple.macl / com.apple.provenance, which re-trigger the dialog.
  // See contributing/desktop-app-development.md §7.
  execFileSync('xattr', ['-cr', appPath]);
  const resigned = relaxAdhocLibraryValidation(appPath);
  console.log(
    `[2/5] Cleared extended attributes (Gatekeeper insurance)` +
      `${resigned ? '; re-signed ad-hoc so an unsigned build can load its own framework' : ''}.`
  );

  const home = mkdtempSync(path.join(os.tmpdir(), 'dorkos-smoke-home-'));
  const app = launchApp(appPath, home);
  console.log(`[3/5] Launched (pid ${app.pid}) against throwaway home ${home}`);

  try {
    const { endpoint, health } = await waitForHealthyServer(app);
    console.log(
      `[4/5] Server healthy on ${endpoint.host}:${endpoint.port} — version ${health.version}`
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
    console.log(
      '[5/5] Data dir isolated, quit cleanly (exit 0), port released. Packaged smoke PASSED.'
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

main().catch((err: unknown) => {
  console.error(`\n[smoke-packaged] FAILED:\n`);
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
